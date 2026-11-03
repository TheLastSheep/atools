/** Deadlines stop catalog observation only. Native reads and completed installs are never cancelled. */
export class PluginCatalogObservation {
  private closed = false;
  private pending = new Set<() => void>();

  read<T>(perform: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(Error("插件列表读取已停止。"));
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const cancel = () => finish(() => reject(Error("插件列表读取已停止。")));
      const timer = setTimeout(() => finish(() => reject(Error("读取插件列表超时，可重新读取。"))), 5000);
      this.pending.add(cancel);
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true; clearTimeout(timer); this.pending.delete(cancel); action();
      };
      Promise.resolve().then(() => {
        if (this.closed) throw Error("插件列表读取已停止。");
        return perform();
      }).then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    });
  }

  dispose() { this.closed = true; for (const cancel of [...this.pending]) cancel(); }
}
