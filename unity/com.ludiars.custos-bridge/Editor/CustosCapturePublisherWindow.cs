using UnityEditor;
using UnityEngine;

namespace Ludiars.Custos.Bridge.Editor
{
    public sealed class CustosCapturePublisherWindow : EditorWindow
    {
        private string _caption = string.Empty;

        [MenuItem("LUDIARS/Custos Bridge/Capture Publisher", false, 20)]
        private static void Open() => GetWindow<CustosCapturePublisherWindow>("Custos Bridge");

        [MenuItem("LUDIARS/Custos Bridge/Send Capture to Session", false, 21)]
        private static void SendFromMenu() => CustosCapturePublisher.Publish("gameview", string.Empty);

        private void OnGUI()
        {
            EditorGUILayout.LabelField("Send GameView capture to session", EditorStyles.boldLabel);
            _caption = EditorGUILayout.TextField("Caption", _caption);
            if (GUILayout.Button("Send to Session")) CustosCapturePublisher.Publish("gameview", _caption);
        }
    }
}
