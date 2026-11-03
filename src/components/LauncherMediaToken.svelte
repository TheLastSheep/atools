<script lang="ts">
 let {kind,summary,onremove}:{kind:"files"|"img";summary:string;onremove:()=>void}=$props();
</script>
<div class="media-token" data-launcher-media-context={kind}>
 <span class="token-summary"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">{#if kind==="img"}<rect x="3" y="3" width="14" height="14" rx="2"/><circle cx="7" cy="7" r="1"/><path d="m4 15 4-4 3 3 3-5 3 6"/>{:else}<path d="M5 2h7l4 4v12H5zM12 2v5h4M8 11h5M8 14h5"/>{/if}</svg><span>{summary}</span></span>
 <button aria-label={kind==="img"?"移除固定图片":"移除固定文件"} onclick={onremove}><svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m4 4 8 8M12 4l-8 8"/></svg></button>
</div>
<style>
 .media-token{display:flex;min-width:0;max-width:42%;flex-shrink:1;align-items:center;border:1px solid color-mix(in srgb,var(--accent) 24%,transparent);border-radius:8px;color:var(--accent);background:var(--accent-subtle);-webkit-app-region:no-drag}
 .token-summary{display:flex;align-items:center;min-width:0;gap:5px;padding:7px 4px 7px 7px;font-size:12px;line-height:16px}.token-summary svg{flex:0 0 auto}.token-summary span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
 button{display:flex;align-items:center;justify-content:center;padding:7px 6px;flex:0 0 auto;align-self:stretch;border:0;border-radius:0 7px 7px 0;background:transparent;color:inherit;cursor:pointer}button:hover{background:color-mix(in srgb,var(--accent) 10%,transparent)}button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>
