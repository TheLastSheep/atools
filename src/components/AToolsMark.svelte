<script lang="ts">
  type Props = {
    size?: "small" | "badge" | "large";
    label?: string;
  };

  let { size = "badge", label = "" }: Props = $props();
</script>

<span
  class={`atools-mark ${size}`}
  aria-hidden={!label}
  aria-label={label || undefined}
  role={label ? "img" : undefined}
>
  <svg viewBox="0 0 128 128" aria-hidden="true" focusable="false">
    <path d="M25 99 55 22c1.7-4.4 3.8-6.5 8.1-6.5 4.1 0 6.4 2.1 8.1 6.5L103 99H82L75 80H53l-7 19H25Zm34-36h10l-5-14-5 14Z" />
  </svg>
</span>

<style>
  .atools-mark {
    --mark-size: 38px;
    --mark-radius: 12px;
    width: var(--mark-size);
    height: var(--mark-size);
    flex: 0 0 var(--mark-size);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    border-radius: var(--mark-radius);
    background: linear-gradient(135deg, #645cf0 0%, #8060ed 52%, #a650e2 100%);
    box-shadow: 0 5px 14px -8px rgba(72, 48, 181, 0.56), inset 0 0 0 1px rgba(255, 255, 255, 0.18);
  }

  .atools-mark.small {
    --mark-size: 42px;
    --mark-radius: 13px;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18);
  }

  .atools-mark.large {
    --mark-size: 72px;
    --mark-radius: 21px;
  }

  svg {
    display: block;
    width: 74%;
    height: 74%;
    fill: #fff;
  }
</style>
