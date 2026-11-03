import type { PublishedBusinessResult, PublishedScenarioContext } from "./nativePublishedPluginCommon";
type TetrisState = { ready: boolean; screen: string; paused: boolean; theme: string; persistedTheme: string | null; board: { pixelHash: string } | null; boardTransition?: { beforeHash: string; afterHash: string } };

export async function runConvertedTetrisScenario(context: PublishedScenarioContext): Promise<PublishedBusinessResult> {
  const { probe, until, check, observations } = context;
  const state = () => probe<TetrisState>("state");
  const wait = (accept: (value: TetrisState) => boolean, label: string) => until(async () => {
    const value = await state(); return value.ready && accept(value) ? value : null;
  }, label);
  await wait(value => value.screen === "home", "Tetris home screen did not render");
  await probe("start-game");
  const started = await wait(value => value.screen === "game" && !!value.board, "Tetris game did not start");
  const moved = await probe<TetrisState>("move-left");
  check(!!started.board?.pixelHash && !!moved.boardTransition?.beforeHash
    && moved.boardTransition.afterHash !== moved.boardTransition.beforeHash,
    "Visible left-move input changes rendered board pixels");
  await probe("pause");
  const paused = await wait(value => value.screen === "game" && value.paused, "Tetris pause overlay did not appear");
  await probe("resume");
  await wait(value => value.screen === "game" && !value.paused, "Tetris game did not resume");
  await probe("pause");
  await probe("settings-from-pause");
  const targetTheme = started.theme === "retro" ? "modern" : "retro";
  const setting = await probe<TetrisState>(targetTheme === "retro" ? "set-theme-retro" : "set-theme-modern");
  check(setting.theme === targetTheme && setting.persistedTheme === targetTheme && setting.theme !== started.theme,
    "Visible theme selection changes and persists in Tetris local storage");
  await probe("settings-return");
  const returned = await wait(value => value.screen === "game" && value.paused && value.theme === targetTheme
    && value.persistedTheme === targetTheme, "Tetris settings did not return to the paused game with saved theme");
  observations.tetrisUi = { started, moved, paused, theme: setting, returned,
    inputBoundary: "DOM-dispatched keyboard and click events; physical keyboard and pointer input are not tested" };
  return { businessOutcome: "scoped_pass", tested: ["visible Home start control", "DOM-dispatched left move with rendered canvas change",
    "visible pause and resume controls", "visible retro theme selection and localStorage readback", "return to paused game"],
    notTested: ["physical keyboard or pointer", "all rotations, drops and collision cases", "long-session scoring or game-over behavior"] };
}
