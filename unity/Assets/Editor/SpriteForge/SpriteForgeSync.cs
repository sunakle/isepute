using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.Networking;

namespace SpriteForge
{
    /// <summary>
    /// Polls the SpriteForge server from the editor and refreshes the AssetDatabase
    /// whenever a sprite is saved on the website. Works outside Play mode.
    /// </summary>
    [InitializeOnLoad]
    public static class SpriteForgeSync
    {
        const string PrefUrl = "SpriteForge.Url";
        const string PrefEnabled = "SpriteForge.Enabled";
        const string SessionRev = "SpriteForge.Rev";

        static UnityWebRequest request;
        static double nextPoll;

        public static bool Connected { get; private set; }
        public static string LastSync { get; private set; } = "—";
        public static event Action Changed;

        public static string Url
        {
            get => EditorPrefs.GetString(PrefUrl, "http://127.0.0.1:7777");
            set => EditorPrefs.SetString(PrefUrl, value.TrimEnd('/'));
        }

        public static bool Enabled
        {
            get => EditorPrefs.GetBool(PrefEnabled, true);
            set => EditorPrefs.SetBool(PrefEnabled, value);
        }

        static int Rev
        {
            get => SessionState.GetInt(SessionRev, -1);
            set => SessionState.SetInt(SessionRev, value);
        }

        public static string ProjectRoot => Path.GetFullPath(Path.Combine(Application.dataPath, ".."));

        static SpriteForgeSync()
        {
            EditorApplication.update += Update;
        }

        static void Update()
        {
            if (!Enabled)
            {
                if (Connected) { Connected = false; Changed?.Invoke(); }
                return;
            }

            if (request != null)
            {
                if (!request.isDone) return;
                Handle(request);
                request.Dispose();
                request = null;
                nextPoll = EditorApplication.timeSinceStartup + 1.0;
                return;
            }

            if (EditorApplication.timeSinceStartup < nextPoll) return;
            if (EditorApplication.isCompiling || EditorApplication.isUpdating) return;

            string url = $"{Url}/api/unity/poll?since={Rev}" +
                         $"&project={UnityWebRequest.EscapeURL(ProjectRoot)}" +
                         $"&name={UnityWebRequest.EscapeURL(Application.productName)}";
            request = UnityWebRequest.Get(url);
            request.timeout = 3;
            request.SendWebRequest();
        }

        static void Handle(UnityWebRequest r)
        {
            bool ok = r.result == UnityWebRequest.Result.Success;
            if (ok != Connected) { Connected = ok; Changed?.Invoke(); }
            if (!ok) return;

            var res = JsonUtility.FromJson<PollResponse>(r.downloadHandler.text);
            if (res == null) return;

            bool firstPoll = Rev < 0;
            Rev = res.rev;
            if (firstPoll || res.changes == null || res.changes.Length == 0) return;

            var names = res.changes.Select(c => c.name).Distinct().ToArray();
            AssetDatabase.Refresh();
            EditorApplication.delayCall += () =>
            {
                foreach (var n in names) SpriteForgeAnimation.Sync(n);
            };
            LastSync = $"{DateTime.Now:HH:mm:ss} — {string.Join(", ", names)}";
            Changed?.Invoke();
        }

        public static void ForceRefresh()
        {
            AssetDatabase.Refresh();
            foreach (var info in SpriteForgeInfo.All()) SpriteForgeAnimation.Sync(info.name);
            LastSync = $"{DateTime.Now:HH:mm:ss} — вручную";
            Changed?.Invoke();
        }

        [Serializable] class PollResponse { public int rev; public Change[] changes; }
        [Serializable] class Change { public int rev; public string name; public string action; }
    }

    /// <summary>Sidecar written by the server to &lt;Project&gt;/SpriteForge/&lt;name&gt;.info.json.</summary>
    [Serializable]
    public class SpriteForgeInfo
    {
        public string name;
        public int w, h, frames = 1, ppu = 16;
        public int[] durations;
        public string pivot = "center";

        public static string Dir => Path.Combine(SpriteForgeSync.ProjectRoot, "SpriteForge");

        public static SpriteForgeInfo Load(string name)
        {
            string path = Path.Combine(Dir, name + ".info.json");
            if (!File.Exists(path)) return null;
            try { return JsonUtility.FromJson<SpriteForgeInfo>(File.ReadAllText(path)); }
            catch { return null; }
        }

        public static SpriteForgeInfo[] All()
        {
            if (!Directory.Exists(Dir)) return new SpriteForgeInfo[0];
            return Directory.GetFiles(Dir, "*.info.json")
                .Select(f => Load(Path.GetFileName(f).Replace(".info.json", "")))
                .Where(i => i != null).ToArray();
        }

        public Vector2 PivotVector =>
            pivot == "bottom" ? new Vector2(0.5f, 0f) :
            pivot == "topleft" ? new Vector2(0f, 1f) :
            new Vector2(0.5f, 0.5f);
    }
}
