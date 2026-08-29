import React, { useEffect, useMemo, useState } from "react";
import type {
  CitationGraph,
  GraphLayer,
  GraphNode,
} from "../types/messages";

const vscode = acquireVsCodeApi();

const LAYERS: GraphLayer[] = ["L3", "L2", "L1"];

const LAYER_TITLES: Record<GraphLayer, string> = {
  L3: "Profile claims",
  L2: "Surface facts",
  L1: "Source events",
};

const LAYER_BADGE: Record<GraphLayer, string> = {
  L3: "bg-purple-700/40 text-purple-200",
  L2: "bg-blue-700/40 text-blue-200",
  L1: "bg-emerald-700/40 text-emerald-200",
};

const KEY_BADGE: Record<string, string> = {
  profile: "bg-purple-800/60 text-purple-200",
  scope: "bg-fuchsia-800/60 text-fuchsia-200",
  recent: "bg-pink-800/60 text-pink-200",
  preferences: "bg-gray-700/60 text-gray-300",
  edit: "bg-blue-800/60 text-blue-200",
  run: "bg-cyan-800/60 text-cyan-200",
  chat: "bg-indigo-800/60 text-indigo-200",
  debug: "bg-amber-800/60 text-amber-200",
  diag: "bg-rose-800/60 text-rose-200",
};

function groupByKey(nodes: GraphNode[]): Array<[string, GraphNode[]]> {
  const m = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    const arr = m.get(n.key) ?? [];
    arr.push(n);
    m.set(n.key, arr);
  }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function badge(key: string, fallback: string): string {
  return KEY_BADGE[key] ?? fallback;
}

export const MemoryGraphPanel: React.FC = () => {
  const [graph, setGraph] = useState<CitationGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as Record<string, unknown>;
      if (msg.type === "memoryGraphData") {
        setGraph(msg.graph as CitationGraph);
        setError(null);
      } else if (msg.type === "error") {
        setError(msg.message as string);
      }
    };
    window.addEventListener("message", handler);
    vscode.postMessage({ type: "getMemoryGraph" });
    return () => window.removeEventListener("message", handler);
  }, []);

  const refresh = () => vscode.postMessage({ type: "getMemoryGraph" });

  const { nodeById, children, parents, chain, counts } = useMemo(() => {
    const nodeById = new Map<string, GraphNode>();
    const children = new Map<string, string[]>();
    const parents = new Map<string, string[]>();
    const counts: Record<GraphLayer, number> = { L3: 0, L2: 0, L1: 0 };

    const push = (m: Map<string, string[]>, k: string, v: string) => {
      const arr = m.get(k);
      if (arr) arr.push(v);
      else m.set(k, [v]);
    };

    if (graph) {
      for (const n of graph.nodes) {
        nodeById.set(n.id, n);
        counts[n.layer] += 1;
      }
      for (const e of graph.edges) {
        push(children, e.from, e.to);
        push(parents, e.to, e.from);
      }
    }

    let chain: Set<string> | null = null;
    if (selectedId && nodeById.has(selectedId)) {
      chain = new Set([selectedId]);
      const stack = [selectedId];
      while (stack.length) {
        const id = stack.pop()!;
        for (const c of children.get(id) ?? []) {
          if (!chain.has(c)) {
            chain.add(c);
            stack.push(c);
          }
        }
      }
      const up = [selectedId];
      while (up.length) {
        const id = up.pop()!;
        for (const p of parents.get(id) ?? []) {
          if (!chain.has(p)) {
            chain.add(p);
            up.push(p);
          }
        }
      }
    }

    return { nodeById, children, parents, chain, counts };
  }, [graph, selectedId]);

  const selected = selectedId ? nodeById.get(selectedId) ?? null : null;
  const hasNodes = graph !== null && graph.nodes.length > 0;

  const cardClass = (nodeId: string) => {
    const isSelected = nodeId === selectedId;
    const inChain = chain?.has(nodeId) ?? false;
    const hasSelection = chain !== null;
    let cls =
      "w-full cursor-pointer rounded border border-gray-700 bg-gray-800/60 px-2 py-1.5 text-left transition-colors hover:border-gray-500 ";
    if (isSelected) cls += "border-blue-400 ring-2 ring-blue-400 ";
    else if (hasSelection && inChain) cls += "border-blue-700/70 ";
    else if (hasSelection && !inChain) cls += "opacity-35 ";
    return cls;
  };

  const renderNode = (node: GraphNode) => {
    const isL1 = node.layer === "L1";
    return (
      <button
        key={node.id}
        className={cardClass(node.id)}
        onClick={() => setSelectedId(node.id === selectedId ? null : node.id)}
      >
        <div className="flex items-center gap-1.5">
          <span
            className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${badge(
              node.key,
              LAYER_BADGE[node.layer]
            )}`}
          >
            {node.key}
          </span>
          {node.section && (
            <span className="truncate text-[10px] text-gray-400">{node.section}</span>
          )}
        </div>
        {isL1 && node.label && (
          <div className="mt-0.5 truncate text-xs font-medium text-gray-100">
            {node.label}
          </div>
        )}
        <div className={`truncate ${isL1 ? "text-[11px] text-gray-400" : "text-xs text-gray-200"}`}>
          {node.text}
        </div>
      </button>
    );
  };

  const renderLayer = (layer: GraphLayer) => {
    const nodes = graph ? graph.nodes.filter((n) => n.layer === layer) : [];
    const groups = groupByKey(nodes);
    return (
      <div className="flex min-w-0 flex-1 flex-col rounded border border-gray-700 bg-gray-900/40">
        <div className="border-b border-gray-700 px-2 py-1.5">
          <span className="text-xs font-semibold text-gray-300">{LAYER_TITLES[layer]}</span>
          <span className="ml-2 text-[10px] text-gray-500">{counts[layer]}</span>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto px-2 py-2">
          {groups.length === 0 && (
            <div className="px-1 py-2 text-center text-xs text-gray-600">— none —</div>
          )}
          {groups.map(([key, groupNodes]) => {
            const inChain = groupNodes.some((n) => chain?.has(n.id) ?? false);
            return (
              <div key={key} className="space-y-1.5">
                <div
                  className={`flex items-center gap-1.5 rounded px-0.5 py-0.5 ${
                    inChain ? "bg-blue-900/30 ring-1 ring-blue-700/60" : ""
                  }`}
                >
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${badge(
                      key,
                      LAYER_BADGE[layer]
                    )}`}
                  >
                    {key}
                  </span>
                  <span className="text-[9px] text-gray-500">{groupNodes.length}</span>
                </div>
                {groupNodes
                  .slice()
                  .sort((a, b) => a.id.localeCompare(b.id))
                  .map(renderNode)}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // Group related node ids by their key (surface / slot), so the two-hop
  // chain reads as "which surface does this claim draw on → which fact".
  const groupIds = (ids: string[]): Array<[string, string[]]> => {
    const m = new Map<string, string[]>();
    for (const id of ids) {
      const n = nodeById.get(id);
      if (!n) continue;
      const arr = m.get(n.key) ?? [];
      arr.push(id);
      m.set(n.key, arr);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  };

  const renderRelated = (ids: string[] | undefined, label: string) => {
    if (!ids || ids.length === 0) return null;
    const groups = groupIds(ids);
    return (
      <div className="mt-2">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">
          {label} ({ids.length})
        </div>
        <div className="mt-1 space-y-1.5">
          {groups.map(([key, groupIds]) => (
            <div
              key={key}
              className="rounded border border-gray-700/70 bg-gray-800/30 p-1.5"
            >
              <div className="mb-1 flex items-center gap-1.5">
                <span
                  className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${badge(
                    key,
                    "bg-gray-700/60 text-gray-300"
                  )}`}
                >
                  {key}
                </span>
                <span className="text-[10px] text-gray-500">{groupIds.length}</span>
              </div>
              <div className="space-y-1">
                {groupIds.map((id) => {
                  const n = nodeById.get(id)!;
                  return (
                    <button
                      key={id}
                      onClick={() => setSelectedId(id)}
                      className="w-full rounded border border-gray-700 bg-gray-800/50 px-2 py-1 text-left text-xs text-gray-300 hover:border-gray-500"
                    >
                      <span
                        className={`mr-1 rounded px-1 py-0.5 text-[9px] font-semibold uppercase ${LAYER_BADGE[n.layer]}`}
                      >
                        {n.layer}
                      </span>
                      <span className="truncate">{n.text}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-gray-600 px-3 py-2">
        <span className="text-sm font-semibold">🕸 Memory Graph</span>
        <div className="flex items-center gap-3">
          {graph && (
            <span className="text-[10px] text-gray-400">
              L3 {counts.L3} · L2 {counts.L2} · L1 {counts.L1}
            </span>
          )}
          <button
            onClick={refresh}
            className="rounded bg-gray-700 px-2 py-1 text-xs hover:bg-gray-600"
            title="Refresh"
          >
            ↻
          </button>
        </div>
      </div>

      {error && (
        <div className="mx-3 mt-2 rounded border border-red-700 bg-red-900/50 px-3 py-2 text-sm text-red-200">
          {error}
        </div>
      )}

      {!hasNodes ? (
        <div className="flex flex-1 flex-col items-center justify-center text-gray-400">
          <p className="text-lg">🕸 No memory yet</p>
          <p className="mt-2 text-sm">
            Update your learner profile first — the citation chain grows out of
            the L1→L2→L3 facts it synthesizes.
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 gap-2 px-3 py-2">
          {LAYERS.map(renderLayer)}
        </div>
      )}

      {selected && (
        <div className="max-h-64 overflow-y-auto border-t border-gray-600 px-3 py-2">
          <div className="flex items-center gap-1.5">
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${LAYER_BADGE[selected.layer]}`}
            >
              {selected.layer}
            </span>
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${badge(
                selected.key,
                LAYER_BADGE[selected.layer]
              )}`}
            >
              {selected.key}
            </span>
            {selected.section && (
              <span className="text-xs text-gray-400">{selected.section}</span>
            )}
            <button
              onClick={() => setSelectedId(null)}
              className="ml-auto rounded px-1.5 text-xs text-gray-500 hover:bg-gray-700"
            >
              ✕
            </button>
          </div>
          <div className="mt-1 whitespace-pre-wrap break-words text-sm text-gray-100">
            {selected.text}
          </div>
          {selected.refs.length > 0 && (
            <div className="mt-2">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                Refs
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {selected.refs.map((r) => (
                  <code key={r} className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-300">
                    {r}
                  </code>
                ))}
              </div>
            </div>
          )}
          {renderRelated(children.get(selected.id), "Cited sources ↓")}
          {renderRelated(parents.get(selected.id), "Cited by ↑")}
        </div>
      )}
    </div>
  );
};
