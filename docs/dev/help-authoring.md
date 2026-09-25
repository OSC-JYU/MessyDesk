## Help Authoring: Columns

Help pages support a custom markdown block for evenly distributed columns.

Use `:::columns N` to set the desktop column count and separate columns with `---`.

```md
:::columns 4
### Column A
Content for the first column.

---
### Column B
Content for the second column.

---
### Column C
Content for the third column.

---
### Column D
Content for the fourth column.
:::
```

Notes:
- On medium screens, columns automatically collapse to at most 2 per row.
- On small screens, columns collapse to a single column.

### Help Authoring: NOTE box

Lines that begin with a NOTE marker are rendered as an emphasized NOTE box.

Supported forms:

```md
**Note:** This is rendered as a note box.
**NOTE** This is also rendered as a note box.
Note: This plain form also becomes a note box.
```

### Help Authoring: Emphasis quote

Use a markdown blockquote for short emphasized statements.

```md
> **TIP:** Control first. AI second.
```

Rendered result:
- The line is shown in a highlighted emphasis box.

### Help Authoring: WARNING box

Use WARNING in a blockquote when the message is important and risky to ignore.

```md
> **WARNING:** This action cannot be undone.
```

Rendered result:
- The line is shown in a warning-style box with a small danger icon.

### Help Authoring: STAMP box

Use STAMP for short, high-visibility statements.

```md
> **STAMP:** Control first. AI second.
```

You can set a color preset with `STAMP:<color>`.

```md
> **STAMP:orange** Control first. AI second.
```

Use inline STAMP inside columns or normal paragraphs:

```md
**STAMP:orange** no-AI
```

Supported presets: `orange`, `red`, `teal`, `blue`, `green`.

Rendered result:
- STAMP text is treated as a style directive and is not shown in output.
- The line is shown as a slightly rotated stamp-style callout that pops visually.

