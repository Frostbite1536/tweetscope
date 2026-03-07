[Steph Ango](https://stephango.com/)/ [Projects](https://stephango.com/projects)[About](https://stephango.com/about) [Now](https://stephango.com/now)

# Flexoki

Flexoki is an inky color scheme for prose and code. Flexoki is designed for reading and writing on digital screens. It is inspired by analog inks and warm shades of paper.

Flexoki is minimalistic and high-contrast. The colors are calibrated for legibility and perceptual balance across devices and when switching between light and dark modes.

Flexoki is [open-source](https://github.com/kepano/flexoki) under the MIT license. Flexoki is available for dozens of popular apps, including [Obsidian](https://stephango.com/obsidian) using my theme [Minimal](https://stephango.com/minimal).

## Palette [\#](https://stephango.com/flexoki\#palette)

Flexoki is the color palette used on this site. To switch between light and dark mode press the `D` key or use the toggle at the top of the page. Click any swatch to copy a color to your clipboard.

bg


bg-2


ui


ui-2


ui-3


tx-3


tx-2


tx


re


or


ye


gr


cy


bl


pu


ma


black


600


300


200


150


100


50


paper


re


or


ye


gr


cy


bl


pu


ma


200


500


700


800


850


900


950


black


re


or


ye


gr


cy


bl


pu


ma


## Syntax highlighting [\#](https://stephango.com/flexoki\#syntax-highlighting)

[![](https://stephango.com/assets/flexoki-code.png)](https://stephango.com/assets/flexoki-code.png)

![](https://stephango.com/assets/flexoki-code-dark.png)

![](https://stephango.com/assets/flexoki-code-light.png)

## Why? [\#](https://stephango.com/flexoki\#why)

I created Flexoki for my personal site, [stephango.com](https://stephango.com/). You’re reading it now. I wanted the colors to feel distinctive yet familiar. Like ink on paper.

The name Flexoki comes from _[flexography](https://en.wikipedia.org/wiki/Flexography)_ — a common printing process for paper and cardboard[1](https://stephango.com/flexoki#fn:1). I spent many years working with dyes and inks particularly for my companies [Inkodye](https://stephango.com/inkodye) and [Lumi](https://stephango.com/lumi). I also have a fascination with [digital paper](https://stephango.com/the-elusiveness-of-digital-paper). I wanted to bring the comfort of analog color to emissive digital screens.

One challenge is that ink on paper is a subtractive process whereas LCD and OLED screens use additive color. Replicating the effect of mixing pigments digitally is difficult. The following video illustrates the problem:

Intro - Practical Pigment Mixing for Digital Painting - YouTube

[Photo image of EbSynth](https://www.youtube.com/channel/UCcYK15gnJhpuIrQ0er9wRUA?embeds_referring_euri=https%3A%2F%2Fstephango.com%2F)

EbSynth

17.1K subscribers

[Intro - Practical Pigment Mixing for Digital Painting](https://www.youtube.com/watch?v=6JVjHqas60Q)

EbSynth

Search

Info

Shopping

Tap to unmute

If playback doesn't begin shortly, try restarting your device.

You're signed out

Videos you watch may be added to the TV's watch history and influence TV recommendations. To avoid this, cancel and sign in to YouTube on your computer.

CancelConfirm

Share

Include playlist

An error occurred while retrieving sharing information. Please try again later.

Watch later

Share

Copy link

Watch on

0:00

0:00 / 0:38

•Live

•

See the [full SIGGRAPH 2021 talk](https://www.youtube.com/watch?v=_qa5iWdfNKg)

Mixing blue and yellow paint creates green, whereas digital color mixing results in a brownish hue. Watercolors retain their saturation when you dilute them, whereas reducing the opacity of digital colors makes them look desaturated.

Another challenge with digital color is [human perception](https://en.wikipedia.org/wiki/List_of_color_spaces_and_their_uses) across color spaces. For example, yellow appears much brighter than blue. Ethan Schoonover’s color scheme [Solarized](https://ethanschoonover.com/solarized/) (2011) was an important inspiration for Flexoki. His emphasis on lightness relationships in the [CIELAB](https://en.wikipedia.org/wiki/CIELAB_color_space) color space helped me understand how to find colors that appear cohesive. Flexoki derives colors from the more recent [Oklab](https://en.wikipedia.org/wiki/Oklab_color_space) color space to maintain those perceptual relationships at the light and dark ends of the spectrum — ramping up color intensity exponentially to emulate the vibrancy that pigments exhibit even when diluted.

I found that choosing colors with perfect perceptual consistency can be at odds with the distinctiveness of colors in practical applications like syntax highlighting. If you adhere too closely to evenness in perceptual lightness you can end up with a palette that looks washed out and difficult to parse.

This project has been a battle between my competing desires in science and art. One part of my brain searches for reliability and precision, while another part searches for those elusive [imperfections](https://stephango.com/scars) that remind us what feels _real_. Solving for all these problems is how I arrived at Flexoki. I hope you find it useful.

## Base color [\#](https://stephango.com/flexoki\#base-color)

Flexoki uses warm monochromatic base values that blend the black value with the paper value. 8 values are used in light and dark mode:

- **3 text values:** normal, muted, faint
- **3 interface values:** normal, hover, active
- **2 background values:** primary, secondary

Incremental values can be derived using opacity. For example, you can use a 60% opacity black value on top of the paper value to create the 600 value.

| Color | Hex | Light theme | Dark theme |
| --- | --- | --- | --- |
| `black` | `#100F0F` | `tx` | `bg` |
| `base-950` | `#1C1B1A` |  | `bg-2` |
| `base-900` | `#282726` |  | `ui` |
| `base-850` | `#343331` |  | `ui-2` |
| `base-800` | `#403E3C` |  | `ui-3` |
| `base-700` | `#575653` |  | `tx-3` |
| `base-600` | `#6F6E69` | `tx-2` |  |
| `base-500` | `#878580` |  | `tx-2` |
| `base-300` | `#B7B5AC` | `tx-3` |  |
| `base-200` | `#CECDC3` | `ui-3` | `tx` |
| `base-150` | `#DAD8CE` | `ui-2` |  |
| `base-100` | `#E6E4D9` | `ui` |  |
| `base-50` | `#F2F0E5` | `bg-2` |  |
| `paper` | `#FFFCF0` | `bg` |  |

## Accent colors [\#](https://stephango.com/flexoki\#accent-colors)

8 accent colors are available for accents and syntax highlighting. Unlike the base values, accent values cannot be derived using opacity because this desaturates the pigment effect. Use the [extended palette](https://stephango.com/flexoki#extended-palette) for the full range of values.

The following 16 values are the main accent values used for syntax highlighting and interface elements like buttons and links. Light themes should use **600** for syntax highlighted text, dark themes should use **400**.

| Color | Hex | Light theme | Dark theme |
| --- | --- | --- | --- |
| `red-600` | `#AF3029` | `re` | `re-2` |
| `orange-600` | `#BC5215` | `or` | `or-2` |
| `yellow-600` | `#AD8301` | `ye` | `ye-2` |
| `green-600` | `#66800B` | `gr` | `gr-2` |
| `cyan-600` | `#24837B` | `cy` | `cy-2` |
| `blue-600` | `#205EA6` | `bl` | `bl-2` |
| `purple-600` | `#5E409D` | `pu` | `pu-2` |
| `magenta-600` | `#A02F6F` | `ma` | `ma-2` |

| Color | Hex | Light theme | Dark theme |
| --- | --- | --- | --- |
| `red-400` | `#D14D41` | `re-2` | `re` |
| `orange-400` | `#DA702C` | `or-2` | `or` |
| `yellow-400` | `#D0A215` | `ye-2` | `ye` |
| `green-400` | `#879A39` | `gr-2` | `gr` |
| `cyan-400` | `#3AA99F` | `cy-2` | `cy` |
| `blue-400` | `#4385BE` | `bl-2` | `bl` |
| `purple-400` | `#8B7EC8` | `pu-2` | `pu` |
| `magenta-400` | `#CE5D97` | `ma-2` | `ma` |

## Extended palette [\#](https://stephango.com/flexoki\#extended-palette)

If you wish to use Flexoki for more complex applications beyond syntax highlighting and basic color schemes, the extended palette includes a complete set of values for every accent color from **50** to **950**.

Note that **paper** and **black** are special values that represent the lightest and darkest colors in the palette, equivalent to **0** and **1000**.

Flexoki emulates the feeling of pigment on paper by exponentially increasing intensity as colors get lighter or darker. This makes the colors feel vibrant and warm, like watercolor inks.

Base

50

#F2F0E5


100

#E6E4D9


150

#DAD8CE


200

#CECDC3


300

#B7B5AC


400

#9F9D96


500

#878580


600

#6F6E69


700

#575653


800

#403E3C


850

#343331


900

#282726


950

#1C1B1A


Red

50

#FFE1D5


100

#FFCABB


150

#FDB2A2


200

#F89A8A


300

#E8705F


400

#D14D41


500

#C03E35


600

#AF3029


700

#942822


800

#6C201C


850

#551B18


900

#3E1715


950

#261312


Orange

50

#FFE7CE


100

#FED3AF


150

#FCC192


200

#F9AE77


300

#EC8B49


400

#DA702C


500

#CB6120


600

#BC5215


700

#9D4310


800

#71320D


850

#59290D


900

#40200D


950

#27180E


Yellow

50

#FAEEC6


100

#F6E2A0


150

#F1D67E


200

#ECCB60


300

#DFB431


400

#D0A215


500

#BE9207


600

#AD8301


700

#8E6B01


800

#664D01


850

#503D02


900

#3A2D04


950

#241E08


Green

50

#EDEECF


100

#DDE2B2


150

#CDD597


200

#BEC97E


300

#A0AF54


400

#879A39


500

#768D21


600

#66800B


700

#536907


800

#3D4C07


850

#313D07


900

#252D09


950

#1A1E0C


Cyan

50

#DDF1E4


100

#BFE8D9


150

#A2DECE


200

#87D3C3


300

#5ABDAC


400

#3AA99F


500

#2F968D


600

#24837B


700

#1C6C66


800

#164F4A


850

#143F3C


900

#122F2C


950

#101F1D


Blue

50

#E1ECEB


100

#C6DDE8


150

#ABCFE2


200

#92BFDB


300

#66A0C8


400

#4385BE


500

#3171B2


600

#205EA6


700

#1A4F8C


800

#163B66


850

#133051


900

#12253B


950

#101A24


Purple

50

#F0EAEC


100

#E2D9E9


150

#D3CAE6


200

#C4B9E0


300

#A699D0


400

#8B7EC8


500

#735EB5


600

#5E409D


700

#4F3685


800

#3C2A62


850

#31234E


900

#261C39


950

#1A1623


Magenta

50

#FEE4E5


100

#FCCFDA


150

#F9B9CF


200

#F4A4C2


300

#E47DA8


400

#CE5D97


500

#B74583


600

#A02F6F


700

#87285E


800

#641F46


850

#4F1B39


900

#39172B


950

#24131D


## Mappings [\#](https://stephango.com/flexoki\#mappings)

This table describes how to use each variable in the context of user interfaces and syntax highlighting.

| Color | Variable | UI | Syntax highlighting |  |
| --- | --- | --- | --- | --- |
|  | `bg` | Main background |  |  |
|  | `bg-2` | Secondary background |  |  |
|  | `ui` | Borders |  |  |
|  | `ui-2` | Hovered borders |  |  |
|  | `ui-3` | Active borders |  |  |
|  | `tx-3` | Faint text | Comments |  |
|  | `tx-2` | Muted text | Punctuation, operators |  |
|  | `tx` | Primary text |  |  |
|  | `re` | Error text | Invalid, imports |  |
|  | `or` | Warning text | Functions |  |
|  | `ye` |  | Constants |  |
|  | `gr` | Success text | Keywords |  |
|  | `cy` | Links, active states | Strings |  |
|  | `bl` |  | Variables, attributes |  |
|  | `pu` |  | Numbers |  |
|  | `ma` |  | Language features |  |

## Ports [\#](https://stephango.com/flexoki\#ports)

Flexoki is available for the following apps and tools. [See the full list](https://github.com/kepano/flexoki).

### Apps [\#](https://stephango.com/flexoki\#apps)

- [Alacritty](https://github.com/kepano/flexoki/tree/main/alacritty)
- [Drafts](https://github.com/kepano/flexoki/tree/main/drafts)
- [Emacs](https://github.com/crmsnbleyd/flexoki-emacs-theme)
- Ghostty (built-in)
- [IntelliJ](https://github.com/kepano/flexoki/tree/main/intellij)
- [iTerm2](https://github.com/kepano/flexoki/tree/main/iterm2)
- [Kitty](https://github.com/kepano/flexoki/tree/main/kitty)
- [Lite XL](https://github.com/kepano/flexoki/tree/main/lite_xl)
- [macOS Terminal](https://github.com/kepano/flexoki/tree/main/terminal)
- [Neovim](https://github.com/kepano/flexoki-neovim)
- [Obsidian](https://github.com/kepano/flexoki-obsidian) and included with [Minimal](https://stephango.com/minimal)
- [Omarchy](https://github.com/euandeas/omarchy-flexoki-dark-theme)
- [Slack](https://github.com/kepano/flexoki/blob/main/slack/slack.md)
- [Standard Notes](https://github.com/myreli/sn-flexoki)
- [Sublime Text](https://github.com/kepano/flexoki-sublime)
- [tmux](https://github.com/kepano/flexoki/tree/main/tmux)
- [Ulysses](https://github.com/kepano/flexoki/tree/main/ulysses)
- [VS Code](https://github.com/kepano/flexoki/tree/main/vscode)
- [Warp](https://github.com/kepano/flexoki/tree/main/warp-terminal)
- [WezTerm](https://github.com/kepano/flexoki/tree/main/wezterm)
- [Windows Terminal](https://github.com/kepano/flexoki/tree/main/windows-terminal)
- [Xresources](https://github.com/kepano/flexoki/tree/main/resources)
- [Zed](https://github.com/kepano/flexoki/tree/main/zed)
- [Zellij](https://github.com/kepano/flexoki/tree/main/zellij)

### Frameworks [\#](https://stephango.com/flexoki\#frameworks)

- [Shadcn](https://gist.github.com/phenomen/affd8c346538378548febd20dccdbfcc)
- [Tailwind](https://gist.github.com/martin-mael/4b50fa8e55da846f3f73399d84fa1848)
- [theme.sh](https://github.com/kepano/flexoki/tree/main/theme.sh)

### Other [\#](https://stephango.com/flexoki\#other)

- [Figma](https://www.figma.com/community/file/1293274371462921490/flexoki)
- [GIMP](https://github.com/kepano/flexoki/tree/main/gimp)

## Contributing [\#](https://stephango.com/flexoki\#contributing)

Flexoki is MIT licensed. You are free to port Flexoki to any app. Please include attribution and a link to [stephango.com/flexoki](https://www.stephango.com/flexoki). You can submit your port to the list via pull request on the [Flexoki repo](https://github.com/kepano/flexoki).

## Changelog [\#](https://stephango.com/flexoki\#changelog)

| Date |  |  |
| --- | --- | --- |
| **2025‑01‑07** | `2.0` | Add 88 new values from 50 to 950 for accent colors. |
| **2023‑10‑07** | `1.0` | Initial release. |

1. [![](https://stephango.com/assets/flexo.jpg)](https://stephango.com/flexo) I also have a [dog named Flexo](https://stephango.com/flexo) whose greatness deserved to be immortalized. [↩](https://stephango.com/flexoki#fnref:1)


[Receive my updates](https://stephango.com/subscribe)

Follow me via email, [RSS](https://stephango.com/feed.xml), [Twitter](https://twitter.com/kepano), and [other options](https://stephango.com/subscribe)

[About me](https://stephango.com/about "About me")[Mastodon](https://mastodon.social/@kepano)