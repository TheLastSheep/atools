<script lang="ts">
  import { onMount } from "svelte";

  type Props = {
    id: string;
    explain: string;
    anchor: HTMLButtonElement;
    onclose: () => void;
  };

  let { id, explain, anchor, onclose }: Props = $props();
  let hintElement: HTMLDivElement | undefined = $state();
  let mounted = $state(false);

  onMount(() => {
    const element = hintElement;
    if (!element) return;
    element.ownerDocument.body.append(element);
    mounted = true;
    return () => element.remove();
  });

  $effect(() => {
    const element = hintElement;
    const target = anchor;
    const description = explain;
    const close = onclose;
    if (!mounted || !element || !description || !target.isConnected) return;
    const document = target.ownerDocument;
    const view = document.defaultView;
    if (!view) return;

    const position = () => {
      if (!target.isConnected || !element.isConnected) {
        close();
        return;
      }
      element.style.visibility = "hidden";
      element.style.left = "8px";
      element.style.top = "8px";
      const hint = element.getBoundingClientRect();
      const button = target.getBoundingClientRect();
      const maxLeft = Math.max(8, view.innerWidth - hint.width - 8);
      const left = Math.max(8, Math.min(button.left + (button.width - hint.width) / 2, maxLeft));
      const spaceBelow = view.innerHeight - button.bottom;
      const placeAbove = button.top >= hint.height + 16 || spaceBelow < hint.height + 16;
      const rawTop = placeAbove ? button.top - hint.height - 8 : button.bottom + 8;
      const maxTop = Math.max(8, view.innerHeight - hint.height - 8);
      const top = Math.max(8, Math.min(rawTop, maxTop));
      element.style.left = `${left}px`;
      element.style.top = `${top}px`;
      element.style.visibility = "visible";
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing && event.keyCode !== 229) {
        const activeElement = document.activeElement;
        const ownsKeyboardFocus = activeElement === target || target.contains(activeElement);
        if (ownsKeyboardFocus) {
          event.preventDefault();
          event.stopPropagation();
        }
        close();
      } else if (event.target !== target) close();
    };
    const externalInput = (event: Event) => {
      if (event.target !== target) close();
    };
    const externalPointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !target.contains(event.target)) close();
    };
    const windowBlur = () => close();

    position();
    view.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("input", externalInput, true);
    document.addEventListener("pointerdown", externalPointer, true);
    view.addEventListener("blur", windowBlur);
    return () => {
      view.removeEventListener("resize", position);
      document.removeEventListener("scroll", position, true);
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("input", externalInput, true);
      document.removeEventListener("pointerdown", externalPointer, true);
      view.removeEventListener("blur", windowBlur);
    };
  });
</script>

<div bind:this={hintElement} id={id} role="tooltip" class="home-command-hint">{explain}</div>

<style>
  .home-command-hint {
    position: fixed;
    z-index: 1000;
    width: max-content;
    max-width: min(288px, calc(100vw - 16px));
    max-height: min(calc(8.7em + 18px), calc(100vh - 16px));
    overflow: hidden;
    padding: 8px 12px;
    border: 1px solid var(--border-strong);
    border-left: 2px solid var(--accent);
    border-radius: 8px;
    color: var(--text-primary);
    background: var(--bg-elevated);
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.16);
    font-size: 11.5px;
    line-height: 1.45;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 6;
    line-clamp: 6;
    pointer-events: none;
    visibility: hidden;
  }
</style>
