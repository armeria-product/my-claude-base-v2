# Section-reference extraction guide

Treat each generated section as a design specification. Before implementation, record all of the following for every primary reference:

- visible copy: headline, supporting copy, actions, labels, and section order when readable;
- typography: display/body relationship, scale, weight, line count, tracking, alignment, and wrapping;
- spacing: gutters, section cadence, text-to-media distance, internal padding, and control rhythm;
- controls and components: action hierarchy, button shape, radius rule, borders, shadows, card logic, icon treatment, and states;
- color and media: background, text hierarchy, accent, image grading, contrast, and media frame proportions;
- layout: grid, focal point, image/text balance, responsive intent, repeated motifs, and what is still unknown.

If a decision cannot be extracted reliably, create a fresh standalone detail or regeneration with the same continuity key. Do not crop a larger reference. Preserve the original design language while making the uncertain text, spacing, or component easier to inspect.

Before comparing the implementation, audit for drift:

- did a distinctive layout become a repeated card row or alternating split?
- did generous spacing become compressed?
- did the palette, typography, action hierarchy, or media treatment change without source evidence?
- did nested containers, fake labels, or default gradient decoration reappear?
- does the first viewport still match the reference's hierarchy and focal point?
