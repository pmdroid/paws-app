# Paws dashboard design

## System

The dashboard uses [Neobrutalism components](https://www.neobrutalism.dev/docs). Copy-in components live under `src/web/src/client/ui`; their upstream MIT license is retained there. Tailwind 4 builds the stylesheet from `theme.css` and the component and layout utilities. Radix Themes is not used.

The palette follows the landing page: lavender canvas, paper panels, near-black outlines, and orange actions. Dark mode uses deep lavender surfaces and light text with the same orange accent and structural borders. Five-pixel radii, bold headings, and four-pixel offset shadows stay with the Neobrutalism components.

## Layout

The dashboard is an operational surface. A 256px desktop Sidebar stretches to the full document height, with viewport-sticky, independently scrollable navigation exposing thirteen pages in Work, Manage, and Settings groups and one current-page indicator. On mobile, the same navigation opens in a modal Sheet, closes after selection, supports Escape, and restores focus. A sticky toolbar names the current page and keeps appearance available. Overview uses a compact summary followed by two full-width bordered sections: Needs you and Working now. Attention rows show an issue, a reason, and a named next action. Working rows preserve explicit state labels.

Buttons, inputs, selects, tabs, and navigation links share a 44px control-height token; wrapping content can grow rather than clip. Content uses consistent section gaps and card padding, with detail grids and boards adapting to their available container width. Mobile sheets and dialogs fit the dynamic viewport and scroll internally when needed.

## Behavior

Appearance defaults to the operating system and supports persistent Light and Dark overrides. The root document owns appearance so portaled dialogs and native controls follow the same theme. Issues uses a filterable list with All, Active, Needs attention, and Done filters. Runs opens an index; run detail uses a toolbar breadcrumb, an issue/title/run header, a full-width workflow stepper and Closeout attempt buttons. Conversations retain a labeled native selector. The toolbar names the current page; its accessible H1 stays in the content region. Overview summarizes queued and waiting-to-merge work in one line, counts current issues rather than historical runs, and keeps attention issues separate from active execution. The active list shows up to six issues and links to All issues.

Native Select and Input components preserve form names, labels, validation, and the existing FormData controllers. Native checkboxes retain label activation. Each page has one H1 and its own empty state. Missing deep-link targets show a recovery choice instead of silently opening another item. Session creation belongs to Conversations. The Settings sidebar group links directly to five separate pages: Agents, Integrations, Workspace access, Your account, and Audit history. Workspace GitHub installation and connection health belong to Integrations; personal GitHub credit and sign-out belong to Your account. Owners sign in with GitHub before choosing an App installation, browsing repositories, and matching each repository to named Linear teams. The searchable, paginated picker preserves multiple team selections and keeps its save action below a bounded list. The control plane verifies access and saves mappings with installation activation atomically; credentials stay on the server. A runner card leads with its name, one status line, a quiet version, OS and seen line, and Pause. Ruled sections follow in a fixed order: Slots lists each busy slot with its issue, phase and elapsed time and folds free slots into one row; Agents shows each agent's sign-in state with usage gauges per limit window, their reset time and the age of the reading, dropping windows that have reset since; Host shows CPU, memory, disk and load against the core count. Gauges reserve their label and bar rows so bars in a row line up, fill lavender and turn orange when high, and host gauges fade to gray once older than two heartbeats. Concurrency, sharing, the copyable ID, Drain and Revoke sit in a separate Settings card. Dynamic markup is translated into the shared component language in `theme.tsx`; polling preserves document and bounded-log scroll positions.

## Direction contract

THESIS: Preserve Paws's operational workflows while fully replacing the previous visual system with the user-selected Neobrutalism library.

OWN-WORLD: Lavender canvas, paper panels, orange actions, high-contrast solid borders, offset shadows, bold type, shared light and dark tokens, and visible native form affordances.

STORY: See what needs attention, inspect work and evidence, then manage execution settings.

FIRST VIEWPORT: A full-page, grouped sidebar with viewport-sticky navigation and a sticky page toolbar frame the status controls and page content. Mobile replaces the sidebar with a menu Sheet. Overview leads with attention and work sections; detail pages lead with a stable heading and route-specific navigation.

FORM: User-pinned Neobrutalism component system, confirmed with its Tailwind and shared-token setup. All existing features and Light / Dark / System appearance remain available.

FINISH: Inspect desktop and mobile captures in both themes, exercise controller interactions, run repository checks, and run the required read-only reviews.
