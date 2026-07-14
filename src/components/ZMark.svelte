<script lang="ts">
  type Props = {
    size?: "small" | "badge" | "large";
    label?: string;
  };

  let { size = "badge", label = "" }: Props = $props();
</script>

<span
  class={`z-mark ${size}`}
  aria-hidden={!label}
  aria-label={label || undefined}
  role={label ? "img" : undefined}
>
  <span class="z-stroke top"></span>
  <span class="z-stroke diagonal"></span>
  <span class="z-stroke bottom"></span>
</span>

<style>
  .z-mark {
    --mark-size: 38px;
    --stroke-height: 4px;
    --stroke-width: 21px;
    --stroke-left: 8px;
    --stroke-top: 10px;
    --stroke-bottom: 10px;
    --diagonal-width: 25px;
    --diagonal-left: 7px;
    --diagonal-top: 17px;
    position: relative;
    width: var(--mark-size);
    height: var(--mark-size);
    flex: 0 0 var(--mark-size);
    display: inline-flex;
    border-radius: 50%;
    background: #111111;
    box-shadow:
      0 12px 28px -14px rgba(0, 0, 0, 0.72),
      inset 0 0 0 1px rgba(255, 255, 255, 0.1);
  }

  .z-mark.small {
    --mark-size: 42px;
    --stroke-height: 5px;
    --stroke-width: 24px;
    --stroke-left: 9px;
    --stroke-top: 12px;
    --stroke-bottom: 12px;
    --diagonal-width: 29px;
    --diagonal-left: 7px;
    --diagonal-top: 19px;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
  }

  .z-mark.large {
    --mark-size: 72px;
    --stroke-height: 7px;
    --stroke-width: 42px;
    --stroke-left: 15px;
    --stroke-top: 20px;
    --stroke-bottom: 20px;
    --diagonal-width: 50px;
    --diagonal-left: 11px;
    --diagonal-top: 32px;
  }

  .z-stroke {
    position: absolute;
    display: block;
    height: var(--stroke-height);
    border-radius: 999px;
    background: #ffffff;
    box-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.2);
  }

  .z-stroke.top {
    top: var(--stroke-top);
    left: var(--stroke-left);
    width: var(--stroke-width);
  }

  .z-stroke.bottom {
    right: var(--stroke-left);
    bottom: var(--stroke-bottom);
    width: var(--stroke-width);
  }

  .z-stroke.diagonal {
    top: var(--diagonal-top);
    left: var(--diagonal-left);
    width: var(--diagonal-width);
    transform: rotate(-33deg);
    transform-origin: center;
  }
</style>
