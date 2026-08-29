// Citation graph builder — the pure backbone of the memory-graph view.
//
// Turns the three persisted layers into a DAG where each node cites the layer
// below it:
//
//     L3 entry ──refs:[surface]──────────▶ L2 entries (of that surface)
//     L2 entry ──refs:[surface:entityId]──▶ L1 entity
//
// Only L1 entities that are actually cited by some L2 entry become nodes —
// uncited trace events are "orphans" (not yet consolidated) and aren't part of
// any citation chain, so they're left out to keep the graph legible.
//
// Pure (no I/O, no `vscode`) so it unit-tests in isolation; the host hydrates
// docs + entities from disk and hands them in.

import type { Document } from "./document";
import type { Entity } from "../snapshot/entity";

export type GraphLayer = "L3" | "L2" | "L1";

export interface GraphNode {
  /** Stable unique id across the graph: `l3:<slot>:<entryId>`, `l2:<surface>:<entryId>`, `l1:<surface>:<entityId>`. */
  id: string;
  layer: GraphLayer;
  /** L3 slot ("profile"/"scope"/"recent") or L2/L1 surface ("edit"/"run"/…). */
  key: string;
  /** Section name for L2/L3 entries (e.g. "Misconceptions"). */
  section?: string;
  /** Display text — fact text (L2/L3) or raw event body (L1). */
  text: string;
  /** Short label for L1 events (kind/summary). */
  label?: string;
  /** Citations into the layer below (surface names for L3, surface:id for L2). */
  refs: string[];
}

export interface GraphEdge {
  /** Citing node id (the higher layer). */
  from: string;
  /** Cited node id (the lower layer). */
  to: string;
}

export interface CitationGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface CitationInputs {
  /** L3 docs keyed by slot (only slots that exist on disk). */
  l3Docs: Record<string, Document>;
  /** L2 docs keyed by surface. */
  l2Docs: Record<string, Document>;
  /** L1 entities keyed by surface (all of them; orphans are pruned). */
  entities: Record<string, Entity[]>;
}

export function buildCitationGraph(inputs: CitationInputs): CitationGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // L2 nodes + the set of L1 refs they cite (drives orphan pruning).
  const l2BySurface = new Map<string, GraphNode[]>();
  const citedRefs = new Set<string>();
  for (const [surface, doc] of Object.entries(inputs.l2Docs)) {
    const surfaceNodes: GraphNode[] = [];
    for (const entry of doc.allEntries()) {
      for (const ref of entry.refs) citedRefs.add(ref);
      surfaceNodes.push({
        id: `l2:${surface}:${entry.id}`,
        layer: "L2",
        key: surface,
        section: entry.section,
        text: entry.text,
        refs: entry.refs,
      });
    }
    l2BySurface.set(surface, surfaceNodes);
    nodes.push(...surfaceNodes);
  }

  // L1 nodes — only entities cited by some L2 entry.
  const l1ById = new Map<string, GraphNode>();
  for (const [surface, list] of Object.entries(inputs.entities)) {
    for (const entity of list) {
      const ref = `${surface}:${entity.id}`;
      if (!citedRefs.has(ref)) continue;
      const node: GraphNode = {
        id: `l1:${ref}`,
        layer: "L1",
        key: surface,
        text: entity.content.trim(),
        label: entity.label,
        refs: [],
      };
      nodes.push(node);
      l1ById.set(ref, node);
    }
  }

  // L2 → L1 edges.
  for (const surfaceNodes of l2BySurface.values()) {
    for (const node of surfaceNodes) {
      for (const ref of node.refs) {
        const target = l1ById.get(ref);
        if (target) edges.push({ from: node.id, to: target.id });
      }
    }
  }

  // L3 nodes + L3 → L2 edges (a surface ref expands to every L2 entry there).
  for (const [slot, doc] of Object.entries(inputs.l3Docs)) {
    for (const entry of doc.allEntries()) {
      const node: GraphNode = {
        id: `l3:${slot}:${entry.id}`,
        layer: "L3",
        key: slot,
        section: entry.section,
        text: entry.text,
        refs: entry.refs,
      };
      nodes.push(node);
      for (const surfaceRef of entry.refs) {
        const surfaceNodes = l2BySurface.get(surfaceRef);
        if (!surfaceNodes) continue;
        for (const target of surfaceNodes) {
          edges.push({ from: node.id, to: target.id });
        }
      }
    }
  }

  return { nodes, edges };
}
