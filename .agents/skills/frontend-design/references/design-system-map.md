# Design-system map

Choose a system only when the product's ecosystem or user expectation makes it the right foundation. Check the package manifest first, use the official package when it applies, and keep one system per project.

| Product context | Foundation | Package evidence to verify |
|---|---|---|
| Microsoft-oriented enterprise UI | Fluent UI | `@fluentui/react-components` |
| Material product UI | Material Web | `@material/web` |
| IBM enterprise UI | Carbon | `@carbon/react`, `@carbon/styles` |
| Shopify embedded app | Polaris | the product's supported Polaris package |
| Atlassian ecosystem | Atlaskit | the required `@atlaskit/*` packages |
| GitHub-like developer surface | Primer | `@primer/css` or the applicable Primer React package |
| UK public service | GOV.UK Frontend | `govuk-frontend` |
| US public service | USWDS | `uswds` |
| Accessible owned React components | Radix or an existing owned component layer | the existing package(s) |
| Modern owned SaaS components | Tailwind plus the product's component layer | existing Tailwind/component dependencies |
| Small conventional MVP | Bootstrap | `bootstrap` |

For editorial, brutalist, bento, frosted-glass, kinetic-type, or similar aesthetic directions, there is no official package. Use the existing stack and describe the choice as an aesthetic implementation. A web frosted-glass treatment is not an official Apple platform material.

Before adding any package, record its name and whether it is present, intentionally unnecessary, or an install command has been proposed. Do not claim a package is installed because an example uses it.
