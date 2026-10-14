# Paws dashboard design

## System

The dashboard uses [Neobrutalism components](https://www.neobrutalism.dev/docs). Copy-in components live under `src/web/src/client/ui`; their upstream MIT license is retained there. Tailwind 4 builds the stylesheet from `theme.css` and the component and layout utilities. Radix Themes is not used.

The palette follows the landing page: lavender canvas, paper panels, near-black outlines, and orange actions. Dark mode uses deep lavender surfaces and light text with the same orange accent and structural borders. Five-pixel radii, bold headings, and four-pixel offset shadows stay with the Neobrutalism components.

## Layout

The dashboard is an operational surface. A 256px desktop Sidebar stretches to the full document height, with viewport-sticky, independently scrollable navigation exposing all nine pages in Work and Manage groups and one current-page indicator. On mobile, the same navigation opens in a modal Sheet, closes after selection, supports Escape, and restores focus. A sticky toolbar names the current page and keeps appearance available. Attention, work in progress, and delivery use bordered sections, with status badges preserving explicit state labels.

Buttons, inputs, selects, tabs, and navigation links share a 44px control-height token; wrapping content can grow rather than clip. Content uses consistent section gaps and card padding, with detail grids and boards adapting to their available container width. Mobile sheets and dialogs fit the dynamic viewport and scroll internally when needed.

## Behavior

Appearance defaults to the operating system and supports persistent Light and Dark overrides. The root document owns appearance so portaled dialogs and native controls follow the same theme. The source picker uses the Neobrutalism Base UI dialog for focus containment and Escape dismissal. Epics uses the library Tabs component for Dependencies and Board, including keyboard activation and associated panels. Labeled native selects choose epics, runs, verification candidates, and conversations; these are entity choices, not tabs.

Native Select and Input components preserve form names, labels, validation, and the existing FormData controllers. Native checkboxes retain label activation. Each page has one H1 and its own empty state. Missing deep-link targets show a recovery choice instead of silently opening another item. Session creation belongs to Conversations; account and workspace administration belong to Settings. Dynamic markup is translated into the shared component language in `theme.tsx`; polling preserves document and bounded-log scroll positions.

## Direction contract

THESIS: Preserve Paws's operational workflows while fully replacing the previous visual system with the user-selected Neobrutalism library.

OWN-WORLD: Lavender canvas, paper panels, orange actions, high-contrast solid borders, offset shadows, bold type, shared light and dark tokens, and visible native form affordances.

STORY: See what needs attention, inspect work and evidence, then manage execution settings.

FIRST VIEWPORT: A full-page, grouped sidebar with viewport-sticky navigation and a sticky page toolbar frame the status controls and page content. Mobile replaces the sidebar with a menu Sheet. Overview leads with attention and work sections; detail pages lead with a stable heading and labeled entity selection.

FORM: User-pinned Neobrutalism component system, confirmed with its Tailwind and shared-token setup. All existing features and Light / Dark / System appearance remain available.

FINISH: Inspect desktop and mobile captures in both themes, exercise controller interactions, run repository checks, and run the required read-only reviews.
