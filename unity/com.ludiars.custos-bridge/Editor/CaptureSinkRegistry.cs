using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using Ludiars.Custos.Bridge.Sinks;

namespace Ludiars.Custos.Bridge.Editor
{
    internal static class CaptureSinkRegistry
    {
        public static ICaptureSink Find(string requestedId)
        {
            string id = string.IsNullOrEmpty(requestedId) ? "concordia-session" : requestedId;
            foreach (var type in TypeCache.GetTypesDerivedFrom<ICaptureSink>())
            {
                if (type.IsAbstract || type.IsInterface) continue;
                if (!(Activator.CreateInstance(type) is ICaptureSink sink)) continue;
                if (string.Equals(sink.Id, id, StringComparison.OrdinalIgnoreCase)) return sink;
            }
            return null;
        }

        public static IReadOnlyList<ICaptureSink> All()
        {
            return TypeCache.GetTypesDerivedFrom<ICaptureSink>()
                .Where(type => !type.IsAbstract && !type.IsInterface)
                .Select(type => Activator.CreateInstance(type) as ICaptureSink)
                .Where(sink => sink != null)
                .ToList();
        }
    }
}
