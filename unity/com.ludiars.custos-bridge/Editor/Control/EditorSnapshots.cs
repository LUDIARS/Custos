// EditorSnapshots.cs — Editor の状態・シーン・ヒエラルキーを JSON にする (main thread 専用)
//
// 形は Custos 側の契約 (src/unity/bridge-contract.ts / public/js/unity-panel.js) に合わせる。
using System.Collections.Generic;
using System.Text;
using UnityEditor;
using UnityEngine;
using UnityEngine.SceneManagement;
using Ludiars.Custos.Bridge.Protocol;

namespace Ludiars.Custos.Bridge.Editor.Control
{
    internal static class EditorSnapshots
    {
        /// <summary>ヒエラルキー 1 回で返すノード数の上限。超えたら truncated。</summary>
        private const int MaxNodes = 500;

        public static string StatusJson()
        {
            var active = SceneManager.GetActiveScene();
            var sb = new StringBuilder("{");
            sb.Append("\"unityVersion\":\"").Append(HttpJson.Escape(Application.unityVersion)).Append("\",");
            sb.Append("\"projectPath\":\"").Append(HttpJson.Escape(System.IO.Path.GetDirectoryName(Application.dataPath))).Append("\",");
            sb.Append("\"isPlaying\":").Append(Bool(EditorApplication.isPlaying)).Append(',');
            sb.Append("\"isPaused\":").Append(Bool(EditorApplication.isPaused)).Append(',');
            sb.Append("\"isCompiling\":").Append(Bool(EditorApplication.isCompiling)).Append(',');
            sb.Append("\"isReloading\":").Append(Bool(EditorApplication.isUpdating)).Append(',');
            sb.Append("\"activeScene\":\"").Append(HttpJson.Escape(active.IsValid() ? active.name : string.Empty)).Append("\",");
            sb.Append("\"dirtyScenes\":[");
            bool first = true;
            for (int i = 0; i < SceneManager.sceneCount; i++)
            {
                var scene = SceneManager.GetSceneAt(i);
                if (!scene.isDirty) continue;
                if (!first) sb.Append(',');
                sb.Append('"').Append(HttpJson.Escape(scene.name)).Append('"');
                first = false;
            }
            sb.Append("]}");
            return sb.ToString();
        }

        public static string SceneJson()
        {
            var active = SceneManager.GetActiveScene();
            var sb = new StringBuilder("{\"activeScene\":\"");
            sb.Append(HttpJson.Escape(active.IsValid() ? active.name : string.Empty)).Append("\",\"scenes\":[");
            for (int i = 0; i < SceneManager.sceneCount; i++)
            {
                var scene = SceneManager.GetSceneAt(i);
                if (i > 0) sb.Append(',');
                sb.Append("{\"name\":\"").Append(HttpJson.Escape(scene.name))
                  .Append("\",\"path\":\"").Append(HttpJson.Escape(scene.path))
                  .Append("\",\"isLoaded\":").Append(Bool(scene.isLoaded))
                  .Append(",\"isDirty\":").Append(Bool(scene.isDirty))
                  .Append(",\"rootCount\":").Append(scene.isLoaded ? scene.rootCount : 0)
                  .Append('}');
            }
            sb.Append("]}");
            return sb.ToString();
        }

        /// <summary>
        /// root (instance id) の子、または読み込み済みシーンのルートから depth 段を返す。
        /// root が見つからなければ null (呼び出し側が 404 にする)。
        /// </summary>
        public static string HierarchyJson(int depth, string root)
        {
            var roots = new List<GameObject>();
            if (string.IsNullOrEmpty(root))
            {
                for (int i = 0; i < SceneManager.sceneCount; i++)
                {
                    var scene = SceneManager.GetSceneAt(i);
                    if (scene.isLoaded) roots.AddRange(scene.GetRootGameObjects());
                }
            }
            else
            {
                if (!int.TryParse(root, out int id)) return null;
                // Unity 6.3 で EntityId 版へ移行中だが、旧版でも動かすため int 版を使い続ける。
#pragma warning disable CS0618
                if (!(EditorUtility.InstanceIDToObject(id) is GameObject parent)) return null;
#pragma warning restore CS0618
                foreach (Transform child in parent.transform) roots.Add(child.gameObject);
            }

            int budget = MaxNodes;
            var sb = new StringBuilder("{\"nodes\":");
            AppendNodes(sb, roots, Mathf.Max(1, depth), ref budget);
            sb.Append(",\"truncated\":").Append(Bool(budget < 0)).Append('}');
            return sb.ToString();
        }

        private static void AppendNodes(StringBuilder sb, List<GameObject> nodes, int depth, ref int budget)
        {
            sb.Append('[');
            bool first = true;
            foreach (var go in nodes)
            {
                if (go == null) continue;
                if (--budget < 0) break;
                if (!first) sb.Append(',');
                first = false;
                var t = go.transform;
                sb.Append("{\"id\":\"").Append(go.GetInstanceID())
                  .Append("\",\"name\":\"").Append(HttpJson.Escape(go.name))
                  .Append("\",\"active\":").Append(Bool(go.activeSelf))
                  .Append(",\"childCount\":").Append(t.childCount)
                  .Append(",\"components\":[");
                var components = go.GetComponents<Component>();
                for (int i = 0; i < components.Length; i++)
                {
                    if (i > 0) sb.Append(',');
                    string name = components[i] != null ? components[i].GetType().Name : "Missing";
                    sb.Append('"').Append(HttpJson.Escape(name)).Append('"');
                }
                sb.Append(']');
                if (depth > 1 && t.childCount > 0)
                {
                    var children = new List<GameObject>(t.childCount);
                    foreach (Transform child in t) children.Add(child.gameObject);
                    sb.Append(",\"children\":");
                    AppendNodes(sb, children, depth - 1, ref budget);
                }
                sb.Append('}');
            }
            sb.Append(']');
        }

        private static string Bool(bool value) => value ? "true" : "false";
    }
}
