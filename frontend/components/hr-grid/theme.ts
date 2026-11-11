import { AllCommunityModule, ModuleRegistry, themeQuartz } from "ag-grid-community";

// Registered once for every HR grid.
ModuleRegistry.registerModules([AllCommunityModule]);

/**
 * The one AG Grid theme for every HR grid. Colours, fonts and radius read the design tokens
 * from app/globals.css (see DESIGN.md), so no page sets grid colours of its own.
 * Rows are 52 px so a row is a full tap target on touch screens.
 */
export const HR_GRID_ROW_HEIGHT = 52;

const token = (name: string) => `var(--color-${name})`;

export const hrGridTheme = themeQuartz.withParams({
  accentColor: token("accent"),
  foregroundColor: token("ink"),
  textColor: token("ink"),
  subtleTextColor: token("ink-muted"),
  backgroundColor: token("surface"),
  chromeBackgroundColor: token("surface"),
  headerBackgroundColor: token("surface-muted"),
  headerTextColor: token("ink-muted"),
  borderColor: token("line"),
  rowBorder: { color: token("line") },
  rowHoverColor: token("surface-muted"),
  selectedRowBackgroundColor: token("accent-soft"),
  checkboxCheckedBackgroundColor: token("accent"),
  checkboxUncheckedBorderColor: token("line-strong"),
  inputBorder: { color: token("line-strong") },
  inputFocusBorder: { color: token("accent") },
  fontFamily: "var(--font-inter), ui-sans-serif, system-ui, sans-serif",
  headerFontFamily: "var(--font-inter), ui-sans-serif, system-ui, sans-serif",
  headerFontWeight: 600,
  fontSize: 13,
  headerFontSize: 13,
  rowHeight: HR_GRID_ROW_HEIGHT,
  headerHeight: 44,
  cellHorizontalPadding: 10,
  wrapperBorderRadius: 12,
  borderRadius: 6,
  wrapperBorder: { color: token("line") },
});
