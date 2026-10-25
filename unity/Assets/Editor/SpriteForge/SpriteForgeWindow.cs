using UnityEditor;
using UnityEngine;

namespace SpriteForge
{
    public class SpriteForgeWindow : EditorWindow
    {
        [MenuItem("Window/SpriteForge")]
        public static void Open() => GetWindow<SpriteForgeWindow>("SpriteForge");

        void OnEnable() => SpriteForgeSync.Changed += Repaint;
        void OnDisable() => SpriteForgeSync.Changed -= Repaint;

        void OnGUI()
        {
            EditorGUILayout.LabelField("Синхронизация спрайтов с сайтом", EditorStyles.boldLabel);
            SpriteForgeSync.Enabled = EditorGUILayout.Toggle("Включено", SpriteForgeSync.Enabled);
            SpriteForgeSync.Url = EditorGUILayout.TextField("Адрес сервера", SpriteForgeSync.Url);

            var prev = GUI.color;
            GUI.color = SpriteForgeSync.Connected ? new Color(0.5f, 1f, 0.5f) : new Color(1f, 0.6f, 0.6f);
            EditorGUILayout.HelpBox(SpriteForgeSync.Connected
                ? "Подключено к SpriteForge"
                : "Нет связи. Запустите SpriteForge/start.bat", MessageType.None);
            GUI.color = prev;

            EditorGUILayout.LabelField("Последняя синхронизация", SpriteForgeSync.LastSync);
            EditorGUILayout.LabelField("Исходники", SpriteForgeInfo.Dir, EditorStyles.miniLabel);

            EditorGUILayout.Space();
            if (GUILayout.Button("Открыть редактор в браузере", GUILayout.Height(28)))
                Application.OpenURL(SpriteForgeSync.Url);
            if (GUILayout.Button("Обновить все спрайты"))
                SpriteForgeSync.ForceRefresh();
        }
    }
}
