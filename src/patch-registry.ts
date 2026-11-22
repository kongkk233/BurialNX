export type PatchRestore = () => void;

/** Session-owned reversible patches. A key can only have one active patch. */
export class PatchRegistry {
  private readonly patches = new Map<string, PatchRestore>();

  replace(key: string, apply: () => PatchRestore): void {
    if (this.patches.has(key)) this.restore(key);
    const restore = apply();
    if (typeof restore !== 'function') throw new TypeError(`Patch '${key}' did not return a restore function`);
    let wrapped!: PatchRestore;
    wrapped = () => {
      try { restore(); }
      finally {
        // A restore callback may install a replacement. Do not delete that new
        // registration when the older wrapper finishes unwinding.
        if (this.patches.get(key) === wrapped) this.patches.delete(key);
      }
    };
    this.patches.set(key, wrapped);
  }

  restore(key: string): boolean {
    const restore = this.patches.get(key);
    if (!restore) return false;
    // Detach before invoking user code. This prevents a restore callback that
    // registers the same key from recursively restoring itself.
    this.patches.delete(key);
    restore();
    return true;
  }

  restoreAll(): number {
    let count = 0;
    let firstError: unknown;
    for (const key of [...this.patches.keys()]) {
      try {
        if (this.restore(key)) count++;
      } catch (error) {
        // One broken cleanup must not prevent unrelated patches from being
        // restored. Re-throw after the complete initial pass for callers that
        // want to report the failure.
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
    return count;
  }

  get activeCount(): number { return this.patches.size; }
}
