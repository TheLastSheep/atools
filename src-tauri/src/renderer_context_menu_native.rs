//! Native menu objects and their owned lifetime, including one closed More level.
use super::PreparedMenuRow;
use tauri::{
    menu::{IsMenuItem, Menu, MenuItem, MenuItemBuilder, PredefinedMenuItem, Submenu},
    AppHandle,
};
enum NativeMenuRow {
    Item(MenuItem<tauri::Wry>),
    Separator(PredefinedMenuItem<tauri::Wry>),
    More(Submenu<tauri::Wry>),
}
impl NativeMenuRow {
    fn as_menu_item(&self) -> &dyn IsMenuItem<tauri::Wry> {
        match self {
            Self::Item(i) => i,
            Self::Separator(i) => i,
            Self::More(i) => i,
        }
    }
}
fn build_rows(app: &AppHandle, rows: &[PreparedMenuRow]) -> Result<Vec<NativeMenuRow>, String> {
    rows.iter()
        .map(|row| {
            Ok(match row {
                PreparedMenuRow::Separator => NativeMenuRow::Separator(
                    PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
                ),
                PreparedMenuRow::Item {
                    native_id,
                    label,
                    enabled,
                } => NativeMenuRow::Item(
                    MenuItemBuilder::with_id(native_id, label)
                        .enabled(*enabled)
                        .build(app)
                        .map_err(|e| e.to_string())?,
                ),
                PreparedMenuRow::More { label, items } => {
                    let children = build_rows(app, items)?;
                    let refs = children
                        .iter()
                        .map(NativeMenuRow::as_menu_item)
                        .collect::<Vec<_>>();
                    NativeMenuRow::More(
                        Submenu::with_items(app, label, true, &refs).map_err(|e| e.to_string())?,
                    )
                }
            })
        })
        .collect()
}
pub(super) fn build_native_menu(
    app: &AppHandle,
    rows: &[PreparedMenuRow],
) -> Result<Menu<tauri::Wry>, String> {
    let rows = build_rows(app, rows)?;
    let refs = rows
        .iter()
        .map(NativeMenuRow::as_menu_item)
        .collect::<Vec<_>>();
    Menu::with_items(app, &refs).map_err(|e| e.to_string())
}
