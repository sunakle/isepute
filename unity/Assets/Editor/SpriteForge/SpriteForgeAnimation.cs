using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace SpriteForge
{
    /// <summary>Creates/updates an AnimationClip (next to the PNG) from a sliced sprite sheet.</summary>
    public static class SpriteForgeAnimation
    {
        /// <summary>Re-imports the PNG (PPU/pivot may change without the pixels changing) and rebuilds its clip.</summary>
        public static void Sync(string name)
        {
            string png = FindPng(name);
            if (png == null) return;
            AssetDatabase.ImportAsset(png, ImportAssetOptions.ForceUpdate);
            Build(name);
        }

        public static void Build(string name)
        {
            var info = SpriteForgeInfo.Load(name);
            string png = FindPng(name);
            if (info == null || png == null) return;

            var sprites = AssetDatabase.LoadAllAssetsAtPath(png).OfType<Sprite>()
                .OrderBy(s => FrameIndex(s.name)).ToArray();
            string clipPath = Path.ChangeExtension(png, ".anim");
            if (sprites.Length < 2 || info.frames < 2) return;

            var clip = AssetDatabase.LoadAssetAtPath<AnimationClip>(clipPath);
            bool isNew = clip == null;
            if (isNew) clip = new AnimationClip { name = name };
            clip.frameRate = 60;

            var keys = new ObjectReferenceKeyframe[sprites.Length + 1];
            float t = 0;
            for (int i = 0; i < sprites.Length; i++)
            {
                keys[i] = new ObjectReferenceKeyframe { time = t, value = sprites[i] };
                int ms = info.durations != null && i < info.durations.Length ? info.durations[i] : 100;
                t += ms / 1000f;
            }
            // Hold the last frame for its full duration before looping.
            keys[sprites.Length] = new ObjectReferenceKeyframe { time = t, value = sprites[sprites.Length - 1] };

            var binding = EditorCurveBinding.PPtrCurve("", typeof(SpriteRenderer), "m_Sprite");
            AnimationUtility.SetObjectReferenceCurve(clip, binding, keys);

            var settings = AnimationUtility.GetAnimationClipSettings(clip);
            settings.loopTime = true;
            AnimationUtility.SetAnimationClipSettings(clip, settings);

            if (isNew) AssetDatabase.CreateAsset(clip, clipPath);
            else EditorUtility.SetDirty(clip);
            AssetDatabase.SaveAssets();
        }

        static string FindPng(string name)
        {
            return AssetDatabase.FindAssets(name + " t:Texture2D")
                .Select(AssetDatabase.GUIDToAssetPath)
                .FirstOrDefault(p => Path.GetFileNameWithoutExtension(p) == name &&
                                     p.EndsWith(".png", System.StringComparison.OrdinalIgnoreCase));
        }

        static int FrameIndex(string spriteName)
        {
            int us = spriteName.LastIndexOf('_');
            return us >= 0 && int.TryParse(spriteName.Substring(us + 1), out int i) ? i : 0;
        }
    }
}
