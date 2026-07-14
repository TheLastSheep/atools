import { onDestroy } from "svelte";

type FlushableSettingsSave = {
  flush: () => Promise<void>;
};

export function registerSettingsSaveFlushOnDestroy(debouncer: FlushableSettingsSave): void {
  onDestroy(() => {
    void debouncer.flush();
  });
}
