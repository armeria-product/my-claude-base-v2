---
name: imagegen-frontend-mobile
description: Create image-only, platform-aware mobile app screen and flow references. Use for mobile visual direction, not website or application implementation.
---

# Mobile screen reference images

Create premium, app-native screen images and coherent flows only. Do not write
SwiftUI, React Native, Flutter, HTML, CSS, or implementation instructions. Do
not turn a requested flow into a website in a phone or one crowded collage.

## Plan the product system first

Choose one platform mode before designing: iOS-native premium, Android-native
premium, or cross-platform premium neutral. Respect an explicit screen count. For
an unspecified app concept or onboarding flow, state a meaningful complete set
and add screens or fresh detail views when a believable journey needs them.

Lock a design bible before the first generation: platform, device-frame style and
scale, palette, type rhythm, spacing, radius, icons, imagery, texture,
navigation, components, buttons, and shadow language. Then order the screens
as a logical journey, such as onboarding to auth to home, browse to detail, or
cart to confirmation.

Read [mobile art direction](references/mobile-art-direction.md) when selecting
platform behavior, visual direction, screen flow, or quality checks.

## Native image route and asset manifest

Use native imagegen directly. Never invoke nested agent commands, external
relays, provider quota checks, or code-generation tools.

Make one native imagegen call for each complete screen. Each manifest entry must
have one output, a unique descriptive relative path, portrait format, explicit
safe-area and navigation treatment, a continuity key matching the design bible,
and a prompt for that specific screen. A useful default is:

    assets/{app}/screens/{number}-{screen}.png

Do not crop, zoom, or reuse a prior board to obtain a detail view. Generate a
fresh standalone image that preserves the locked system. Default to a subtle,
consistent phone frame with even outer margins and content as the visual focus;
a raw screen needs an explicit borderless reason.

After a platform-supported file handoff, verify the selected destination exists
and is non-empty. If native imagegen returns only a conversation image, report
that no local copy exists rather than inventing a path.

Validate saved manifests before rendering:

    node .agents/skills/imagegen-frontend-mobile/scripts/validate-mobile-plan.mjs path/to/mobile-plan.json

## Quality bar

The first screen needs one clear focal point, short readable copy, and one
obvious next action. Respect top and bottom system regions, use believable
navigation, keep controls touch-friendly, and let dense screens alternate with
calmer screens. Vary composition and image emphasis without drifting into a
second design system.

Use imagery, texture, fades, masks, and small creative assets only when they
serve the category and preserve readability. Regenerate any screen that has tiny
type, unsafe content placement, repetitive onboarding, fake navigation,
box-in-box clutter, a generic palette, or uneven device framing.
