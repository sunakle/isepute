using System.IO;
using UnityEditor;
using UnityEngine;

namespace SpriteForge
{
    /// <summary>
    /// Applies pixel-art import settings to PNGs that have a SpriteForge sidecar
    /// and slices horizontal sprite sheets into one sprite per frame.
    /// </summary>
    public class SpriteForgeImporter : AssetPostprocessor
    {
        void OnPreprocessTexture()
        {
            if (!assetPath.EndsWith(".png", System.StringComparison.OrdinalIgnoreCase)) return;
            string name = Path.GetFileNameWithoutExtension(assetPath);
            var info = SpriteForgeInfo.Load(name);
            if (info == null) return;

            var ti = (TextureImporter)assetImporter;
            ti.textureType = TextureImporterType.Sprite;
            ti.filterMode = FilterMode.Point;
            ti.textureCompression = TextureImporterCompression.Uncompressed;
            ti.mipmapEnabled = false;
            ti.alphaIsTransparency = true;
            ti.wrapMode = TextureWrapMode.Clamp;
            ti.spritePixelsPerUnit = Mathf.Max(1, info.ppu);

            var settings = new TextureImporterSettings();
            ti.ReadTextureSettings(settings);
            settings.spriteMeshType = SpriteMeshType.FullRect;
            settings.spriteAlignment = (int)SpriteAlignment.Custom;
            settings.spritePivot = info.PivotVector;
            ti.SetTextureSettings(settings);

            if (info.frames <= 1)
            {
                ti.spriteImportMode = SpriteImportMode.Single;
                ti.spritePivot = info.PivotVector;
                return;
            }

            ti.spriteImportMode = SpriteImportMode.Multiple;
            var sheet = new SpriteMetaData[info.frames];
            for (int i = 0; i < info.frames; i++)
            {
                sheet[i] = new SpriteMetaData
                {
                    name = $"{name}_{i}",
                    rect = new Rect(i * info.w, 0, info.w, info.h),
                    alignment = (int)SpriteAlignment.Custom,
                    pivot = info.PivotVector,
                };
            }
#pragma warning disable 0618 // spritesheet is deprecated in newer Unity versions but still applied on import
            ti.spritesheet = sheet;
#pragma warning restore 0618
        }
    }
}
