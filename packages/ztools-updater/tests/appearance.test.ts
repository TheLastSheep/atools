import { expect, it, vi } from 'vitest'
import { createUpdaterAppearance, parseAppearance, type Appearance } from '../src/appearance'
const id = '1'.repeat(32)
const state = (sequence = 1): Appearance => ({windowId:id,sequence,platform:'darwin',material:'none',nativeMaterial:'fullscreen-ui',materialApplied:true,theme:'dark',effectiveTheme:'dark',opacity:0.8,opacityApplied:true,acrylicOpacity:{light:78,dark:50},error:null})
it('appearance listener precedes single read; early newer actual state wins and foreign/stale callbacks do not change it', async () => {
  let callback:(value:unknown)=>void=()=>{}, release!:(value:unknown)=>void
  const unlisten=vi.fn(), invoke=vi.fn(async()=>new Promise(resolve=>{release=resolve}))
  const client=createUpdaterAppearance(id,{invoke,listen:async cb=>{callback=cb;return unlisten}})
  const received: string[]=[];client.onMaterial(value=>received.push(value))
  const first=client.getWindowMaterial(),second=client.getWindowMaterial();await vi.waitFor(()=>expect(invoke).toHaveBeenCalledTimes(1))
  callback({...state(3),material:'acrylic'});callback({...state(9),windowId:'f'.repeat(32),material:'mica'});release(state(1))
  expect(await first).toBe('acrylic');expect(await second).toBe('acrylic');expect(received).toEqual(['acrylic'])
  client.dispose();expect(unlisten).toHaveBeenCalledTimes(1)
})
it('late appearance subscription after disposal is immediately removed without a read', async () => {
  let release!:(stop:()=>void)=>void;const stop=vi.fn(),invoke=vi.fn(async()=>state())
  const client=createUpdaterAppearance(id,{invoke,listen:async()=>new Promise(resolve=>{release=resolve})})
  const pending=client.getWindowMaterial();client.dispose();release(stop)
  await expect(pending).rejects.toThrow();expect(stop).toHaveBeenCalledTimes(1);expect(invoke).not.toHaveBeenCalled()
})
it('rejects non-finite/out-of-range opacity, getters and unknown fields without fabricating an applied value', () => {
  for(const raw of [{...state(),opacity:NaN},{...state(),acrylicOpacity:{light:101,dark:10}},{...state(),acrylicOpacity:{light:20.5,dark:10}},{...state(),extra:true}])expect(()=>parseAppearance(raw)).toThrow()
  let touched=false;expect(()=>parseAppearance({...state(),get material(){touched=true;return'none'}})).toThrow();expect(touched).toBe(false)
  expect(parseAppearance({...state(),opacity:0}).opacity).toBe(0)
  expect(parseAppearance({...state(),material:'none',materialApplied:false,error:{code:'unsupported_material',message:'不可用'}}).materialApplied).toBe(false)
})

it('retains unknown opacity as null/false without blocking known material or acrylic information',async()=>{
  const partial={...state(),material:'mica' as const,opacity:null,opacityApplied:false,error:{code:'appearance_partial',message:'当前平台无法读取实际透明度'}};
  expect(()=>parseAppearance({...partial,opacityApplied:true})).toThrow();
  const invoke=vi.fn(async()=>partial),client=createUpdaterAppearance(id,{invoke,listen:async()=>()=>{}});
  const values:number[]=[];client.onOpacity(value=>values.push(value.lightOpacity));
  expect(await client.getWindowMaterial()).toBe('mica');expect(client.snapshot()?.opacity).toBeNull();expect(client.snapshot()?.opacityApplied).toBe(false);
  expect(client.snapshot()?.error?.code).toBe('appearance_partial');expect(values).toEqual([78]);client.dispose();
});
