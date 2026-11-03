import "../../src/styles/global.css";
import { flushSync, mount as mountSvelte, tick, unmount } from "svelte";
import PluginNavigationBar from "../../src/components/PluginNavigationBar.svelte";

const target = document.querySelector<HTMLElement>("#navigation");
if (!target) throw new Error("Missing plugin-navigation fixture target");

const callbacks: string[] = [];
let component: ReturnType<typeof mountSvelte> | undefined;

const actions = [
  { id: "settings" as const, label: "设置", available: true },
  { id: "detach" as const, label: "分离", available: true },
];

async function mountFixture(inputVisible: boolean) {
  if (component) await unmount(component);
  component = undefined;
  callbacks.length = 0;
  component = mountSvelte(PluginNavigationBar, {
    target,
    props: {
      title: "一个用于验证窄屏布局的超长插件标题与工作区名称",
      feature: "very-long-feature-label-for-layout-check",
      source: "fixture://plugins/long-source-identity-for-layout-check",
      actions,
      inputVisible,
      value: "",
      placeholder: "输入插件内关键词",
      controlsId: "fixture-plugin-results",
      activeDescendantId: "fixture-plugin-result-1",
      oninput: (value: string) => callbacks.push(value),
      onreturn: () => {},
      onescape: () => {},
      onaction: () => {},
      runtimeInfo: {
        controlsId: "fixture-runtime-info",
        expanded: false,
        attention: "warning" as const,
        onToggle: () => {},
      },
    },
  });
  flushSync();
  await tick();
}

async function dispose() {
  if (component) await unmount(component);
  component = undefined;
  callbacks.length = 0;
}

Object.assign(window, {
  pluginNavigationClearFixture: {
    callbacks,
    mountFixture,
    dispose,
  },
});

void mountFixture(false);
