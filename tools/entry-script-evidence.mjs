/**
 * Describe the declared entry.script without implying that it was injected.
 * The HTML script graph remains authoritative for loading order.
 */
export function entryScriptEvidence({ profile, scriptGraph, executedScripts } = {}) {
  const declared = profile?.entry?.script ?? null;
  const graphIndex = declared === null ? null : scriptGraph.indexOf(declared);
  if (declared !== null && graphIndex < 0) {
    throw new Error(`entry.script is not present in the executed script graph: ${declared}`);
  }

  const observed = Array.isArray(executedScripts);
  const executionIndex = !observed || declared === null ? null : executedScripts.indexOf(declared);
  if (observed && declared !== null && executionIndex !== graphIndex) {
    throw new Error(`entry.script execution order differs from HTML script graph: ${declared}`);
  }

  return {
    declared,
    graph: {
      status: declared === null ? 'not-declared' : 'pass',
      path: declared,
      index: graphIndex,
    },
    execution: {
      status: declared === null ? 'not-declared' : observed ? 'observed' : 'not-observed',
      observed: observed && declared !== null,
      index: executionIndex,
    },
  };
}
