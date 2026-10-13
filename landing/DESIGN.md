---
name: Paws Landing
description: Lavender retro desktop with readable software windows and tactile orange actions
colors:
  desktop: "#c0b4f1"
  paper: "#fdfdfb"
  ink: "#101317"
  muted: "#57516c"
  orange: "#ff793e"
  green: "#258b47"
  orange-hover: "#ff925d"
  paper-hover: "#eee8f9"
  dock: "#e5ddf5"
  stage-selected: "#e8e1f7"
  stage-hover: "#f0ebf8"
  terminal-text: "#f8f8f8"
  terminal-muted: "#e0dceb"
  decoration-green: "#54b76b"
typography:
  display:
    fontFamily: "Baloo 2, Bricolage, sans-serif"
    fontSize: "clamp(54px, 6.3vw, 96px)"
    fontWeight: 800
    lineHeight: 0.99
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "Bricolage, sans-serif"
    fontSize: "clamp(32px, 3.4vw, 52px)"
    fontWeight: 800
    letterSpacing: "-0.035em"
  title:
    fontFamily: "Bricolage, sans-serif"
    fontSize: "30px"
    letterSpacing: "-0.03em"
  intro:
    fontFamily: "Bricolage, sans-serif"
    fontSize: "clamp(20px, 1.75vw, 26px)"
    lineHeight: 1.28
  body:
    fontFamily: "Bricolage, sans-serif"
    fontSize: "19px"
    lineHeight: 1.55
  button:
    fontFamily: "Bricolage, sans-serif"
    fontSize: "20px"
    fontWeight: 750
    lineHeight: 1.2
  label:
    fontFamily: "DM Mono, monospace"
    fontSize: "14px"
    lineHeight: 1.3
  detail:
    fontFamily: "DM Mono, monospace"
    fontSize: "12px"
    lineHeight: 1.5
  terminal:
    fontFamily: "DM Mono, monospace"
    fontSize: "16px"
    lineHeight: 1.7
rounded:
  window: "12px"
  dock: "10px"
  workflow: "9px"
  control: "8px"
  row: "6px"
  circle: "50%"
spacing:
  compact: "8px"
  small: "12px"
  regular: "16px"
  comfortable: "20px"
  panel: "24px"
  roomy: "28px"
components:
  button-primary:
    backgroundColor: "{colors.orange}"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "14px 28px"
  button-primary-hover:
    backgroundColor: "{colors.orange-hover}"
  button-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "14px 28px"
  button-secondary-hover:
    backgroundColor: "{colors.paper-hover}"
  window:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.window}"
  window-titlebar:
    backgroundColor: "{colors.desktop}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    padding: "8px 22px"
  stage-control:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.row}"
    padding: "13px 16px"
  stage-control-selected:
    backgroundColor: "{colors.stage-selected}"
  stage-control-hover:
    backgroundColor: "{colors.stage-hover}"
  completion-badge:
    backgroundColor: "{colors.green}"
    textColor: "white"
    rounded: "{rounded.circle}"
    width: "21px"
    height: "21px"
  tool-dock:
    backgroundColor: "{colors.dock}"
    textColor: "{colors.ink}"
    rounded: "{rounded.dock}"
    padding: "12px 18px"
  terminal:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.terminal-text}"
    rounded: "{rounded.control}"
  navigation:
    textColor: "{colors.ink}"
    padding: "8px 12px"
---

# Design System: Paws Landing

## Overview

**Creative North Star: "The Lavender Desktop"**

A familiar personal-computer desktop becomes a warm home for Paws. Cool lavender surrounds near-white software windows with crisp near-black outlines. Baloo 2 gives the hero a rounded, friendly voice; Bricolage carries the remaining headings, prose, and actions, while DM Mono supplies software captions and commands.

Spacious copy sits beside compact window furniture. Orange actions feel tactile, green checkmarks communicate completion, and a sleeping pixel puppy warms the dark terminal. Containment and contrasting surfaces create depth without shadows.

**Key Characteristics:**

- Cool lavender desktop and caption bars surrounding near-white content.
- Rounded Baloo 2 hero, Bricolage supporting type, and DM Mono software details.
- Crisp outlines, modest rounded corners, and circular status marks.
- A separate timeline rail beside recognizable tool symbols.
- Orange actions, visible keyboard focus, and reduced-motion support.

## Colors

The palette pairs a cool lavender workspace with warm paper, dark ink, and clear action and completion colors. Frontmatter values are authoritative.

### Primary

- **Desktop Lavender:** Page background, caption bars, and terminal prompt; the source shares this value between desktop and bar custom properties.
- **Action Orange:** Primary actions, text selection, the coding-agent stage, and the first window dot; its lighter hover keeps ink text.

### Secondary

- **Completion Green:** Filled badges with white checkmarks.
- **Decoration Green:** Third window dot and workflow endpoint.

### Neutral

- **Warm Paper / Near-Black Ink:** Readable windows, outlined structure, and dark terminal surfaces.
- **Muted Violet:** Supporting prose, captions, and metadata.
- **Dock Lavender:** Lighter tool tray.
- **Stage Selected / Stage Hover:** Distinct pale fills for pressed controls and pointer hover.
- **Terminal Text / Terminal Muted:** Commands and supporting copy on dark surfaces.

**The Shared Desktop Rule.** Window caption bars repeat the desktop lavender so nested windows belong to the same workspace.

**The State Has a Shape Rule.** Completion uses a checkmark as well as green; selected workflow controls use a border as well as a changed fill.

## Typography

**Display Font:** Baloo 2, weight (800), self-hosted through @fontsource/baloo-2/latin-800.css; Bricolage and sans-serif fallbacks.

**Supporting and Body Font:** Local Bricolage variable font, weights (400–800), with sans-serif fallback.

**Label and Command Font:** Local DM Mono regular, with monospace fallback. All three faces use swap loading.

### Hierarchy

- **Display:** Frontmatter display role; (6vw) below the compact breakpoint, (clamp(41px, 8.4vw, 64px)) when stacked, and (39px) on the narrowest layout.
- **Headline:** Fluid section heading; local heading uses (clamp(40px, 4vw, 60px)), weight (800), line height (1.03), and tracking (-0.035em).
- **Title:** Detail and setup titles use the title role; workflow row titles use (18px), weight (750), and line height (1.25).
- **Intro / Body:** Intro measure is (38ch), expanding to (45ch) when stacked. Detail copy uses (48ch); local prose uses (20px/1.5) with a (40ch) measure.
- **Label / Detail / Terminal:** DM Mono captions and metadata use the recorded roles. Terminal captions and local notes use (13px); commands reduce to (13px) at the compact breakpoint.
- **Button:** Bricolage actions step from (20px) to (17px), (16px), and (15px) across responsive rules.

**The Three Voices Rule.** Use Baloo 2 for the hero headline, Bricolage for other headings, prose, and actions, and DM Mono for window captions, commands, and compact status details.

## Layout

The centered desktop caps at (1536px), with (4.3%) horizontal gutters, becoming (66px) at the cap. Navigation has a minimum height of (80px). The hero uses a (1.6fr / 1fr) grid, (28px) gap, and (38px 3% 16px) padding. The workflow explorer splits (1fr / 1.1fr) with a (48px) gap; the local/setup pairing uses equal columns, a (10%) gap, and (90px 6%) padding.

At (1100px) and below, hero columns tighten to (1.35fr / 1fr), and furniture and actions contract. At (780px) and below, content grids stack, gutters become (18px), and the full-width dock keeps text while hiding icons. Navigation retains workflow and GitHub links. At (390px) and below, gutters become (12px), with smaller padding and type.

Recurring spacing steps are recorded in frontmatter. Actions wrap; command blocks scroll horizontally. The mobile terminal body has a minimum height of (190px), leaving the puppy a separate bottom-right area beneath the command copy.

## Elevation & Depth

No box shadows. Ink borders and tonal layering distinguish desktop, paper windows, caption strips, and inset terminals. Windows and action controls use (2px) structural borders; dock dividers and workflow selection use (1px).

**The Outlined Window Rule.** Define window edges with ink borders and contrasting caption bars; keep their rounded silhouettes intact through clipped overflow.

The hero settles from (8px) below its resting position over (550ms), using (cubic-bezier(0.16, 1, 0.3, 1)). Pressed actions move down (1px). Reduced motion removes the entrance and makes anchor scrolling automatic.

## Shapes

Rounded rectangles form the furniture: main windows (12px), dock (10px), nested workflow (9px), controls and terminal (8px), and selection rows and command blocks (6px). Circles mark window decorations, timeline nodes, tool badges, numbered steps, and completion.

Functional SVGs use rounded strokes on a (24px) canvas. Linear, Claude, and GitHub symbols use official simple-icons filled paths, not stroked approximations. Window dots are noninteractive and hidden from accessibility APIs.

## Components

### Buttons

Tactile outlined action links: orange primary, paper secondary, ink text, and (2px) borders. Desktop minimum height is (60px), with (14px 28px) padding and (20px) icon gap. Hover changes the fill; active presses move down (1px). Focus uses a (3px) purple outline offset by (5px). Setup actions fill their panel with a (54px) minimum height.

### Cards / Containers

Paper software windows use clipped corners, ink outlines, and lavender monospaced title bars with three decorative dots. Caption minimum height is (40px). Nested workflow captions use (10px 16px) padding; setup content uses (28px), reducing to (24px) when stacked.

### Navigation

Bricolage brand (42px), weight (800), tracking (-0.035em), with a filled paw SVG. Menu links use (17px), weight (650), and (36px) gaps, with underlined hover and visible focus. Stacked sizes are (34px) for the brand and (13px) for links, with (18px) gaps.

### Workflow Controls

Native buttons with numbered circles, left-aligned labels, trailing SVG arrows, and aria-pressed state. Selection adds an ink border and selected fill; hover uses its own fill, including on selected rows. Activation updates the heading, description, and guide link in a polite atomic live region. Minimum row height is (58px), reducing to (52px) when stacked.

### Workflow Timeline and Completion

A separate (2px) vertical rail connects outlined paper nodes beside the tool badges. Linear, Claude, and GitHub use official filled symbols; Closeout uses a stroked checkmark. Tool badges are (38px) circles with (21px) symbols. Independent green completion badges are (21px) circles with white checks; the endpoint combines a green node and readable outcome label.

### Tool Dock

A lavender outlined tray with four labeled groups and vertical ink dividers. Desktop labels use (15px), weight (700), with (28px) horizontal padding. Official tool symbols are (26px), with Claude colored terracotta. The stacked layout hides symbols while retaining all names.

### Terminal

A dark inset window with a lavender caption. DM Mono commands sit above a sleeping pixel puppy at the right; the prompt repeats desktop lavender. On mobile the body is at least (190px) tall and the puppy occupies a (100px × 70px) contained bottom-right area. Setup commands repeat the dark surface with (14px/1.9) mono text.

## Do's and Don'ts

### Do:

- **Do** repeat desktop lavender in window captions and use paper for readable content.
- **Do** reserve Baloo 2 for the hero and pair Bricolage supporting type with DM Mono software details.
- **Do** preserve outlined rounded windows, separate timeline nodes, and recognizable official tool symbols.
- **Do** keep keyboard focus visible and expose selected workflow state with aria-pressed.
- **Do** retain tool names and give terminal copy and the puppy separate space on mobile.
- **Do** honor reduced-motion preferences for entrance and anchor scrolling.

### Don't:

- **Don't** turn decorative window dots into fake interactive controls.
- **Don't** use color alone to communicate completion or workflow selection.
- **Don't** substitute shadows for the outlined, tonally layered window structure.
