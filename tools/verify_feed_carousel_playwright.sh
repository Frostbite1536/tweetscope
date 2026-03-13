#!/usr/bin/env bash
set -euo pipefail

PLAYWRIGHT_CLI_BIN="${PLAYWRIGHT_CLI_BIN:-/opt/homebrew/bin/playwright-cli}"
SESSION_ID="${SESSION_ID:-fc-$RANDOM}"
TARGET_URL="${1:-http://127.0.0.1:5174/datasets/defenderofbasic/explore/scopes-001}"
API_HEALTH_URL="${API_HEALTH_URL:-http://127.0.0.1:3000/api/health}"

cleanup() {
  "$PLAYWRIGHT_CLI_BIN" -s="$SESSION_ID" close >/dev/null 2>&1 || true
}

trap cleanup EXIT

if ! command -v "$PLAYWRIGHT_CLI_BIN" >/dev/null 2>&1; then
  echo "playwright-cli not found at $PLAYWRIGHT_CLI_BIN" >&2
  exit 1
fi

if ! curl -fsS "$TARGET_URL" >/dev/null; then
  echo "Frontend not reachable at $TARGET_URL" >&2
  exit 1
fi

if ! curl -fsS "$API_HEALTH_URL" >/dev/null; then
  echo "API not reachable at $API_HEALTH_URL" >&2
  exit 1
fi

"$PLAYWRIGHT_CLI_BIN" -s="$SESSION_ID" open "$TARGET_URL" --browser=chrome >/dev/null

read -r -d '' PLAYWRIGHT_CODE <<'EOF' || true
async page => {
  const wait = (ms) => page.waitForTimeout(ms)
  const assert = (condition, message, extra = null) => {
    if (!condition) {
      const suffix = extra ? `\n${JSON.stringify(extra, null, 2)}` : ''
      throw new Error(`${message}${suffix}`)
    }
  }

  const clusterButton = (text) =>
    page.locator('div[class*="_list_"] > div > button').filter({ hasText: text }).first()

  const subclusterButton = (text) =>
    page.locator('div[class*="_list_"] [role="button"]').filter({ hasText: text }).first()

  const getState = async () => page.evaluate(() => {
    const carousel = document.querySelector('div[class*="_carousel_"]')
    const toc = document
      .querySelector('input[placeholder="Search topics..."]')
      ?.closest('div[class*="_container_"]')
    const active = Array.from(
      document.querySelectorAll('div[class*="_list_"] > div > button')
    ).find((button) => button.className.includes('_active_'))
    const events = window.__LATENT_SCOPE_FEED_CAROUSEL_DEBUG_EVENTS__ || []

    return {
      scrollLeft: carousel?.scrollLeft ?? null,
      tocClass: toc?.className ?? null,
      isStickyShell: toc?.className.includes('_stickyShell_') ?? false,
      isStickyVisible: toc?.className.includes('_stickyVisible_') ?? false,
      tocOpacity: toc ? getComputedStyle(toc).opacity : null,
      tocLeft: toc?.getBoundingClientRect().left ?? null,
      tocRight: toc?.getBoundingClientRect().right ?? null,
      activeText: active?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 140) ?? null,
      sortTitle: document
        .querySelector('button[title="Descending"], button[title="Ascending"]')
        ?.getAttribute('title') ?? null,
      debugTail: events.slice(-6),
    }
  })

  const revealStickyToc = async () => {
    await page.mouse.move(20, 200)
    await wait(400)
    let state = await getState()
    if (state.isStickyVisible && state.tocOpacity === '1') return state

    await page.evaluate(() => {
      const hoverZone = document.querySelector('div[class*="_hoverZone_"]')
      hoverZone?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
    })
    await wait(400)
    state = await getState()
    assert(
      state.isStickyVisible && state.tocOpacity === '1',
      'Sticky ToC did not become visible after hover reveal',
      state
    )
    return state
  }

  const hideStickyToc = async () => {
    await page.mouse.move(500, 200)
    await wait(1200)
    const state = await getState()
    assert(
      state.isStickyShell && !state.isStickyVisible && state.tocOpacity === '0',
      'Sticky ToC did not hide after pointer exit',
      state
    )
    return state
  }

  const setCarouselScroll = async (scrollLeft) => {
    await page.evaluate((nextScrollLeft) => {
      const carousel = document.querySelector('div[class*="_carousel_"]')
      carousel?.scrollTo({ left: nextScrollLeft, behavior: 'auto' })
    }, scrollLeft)
    await wait(1200)
  }

  await page.evaluate(() => {
    localStorage.setItem('debug:feed-carousel', '1')
    window.__LATENT_SCOPE_DEBUG_FEED_CAROUSEL__ = true
  })
  await page.reload()
  await wait(3000)

  let expandReady = false
  for (let attempt = 0; attempt < 40; attempt += 1) {
    expandReady = await page.evaluate(
      () => Boolean(document.querySelector('button[title="Expand to carousel"]'))
    )
    if (expandReady) break
    await wait(500)
  }
  assert(expandReady, 'Expand-to-carousel control did not render in time')

  let sidebarReady = false
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await page.evaluate(() => document.querySelector('button[title="Expand to carousel"]')?.click())
    await wait(500)
    sidebarReady = await page.evaluate(
      () => Boolean(document.querySelector('input[placeholder="Search topics..."]'))
    )
    if (sidebarReady) break
  }
  assert(sidebarReady, 'Expanded carousel sidebar did not render in time')
  await wait(2000)

  const resetTrials = []
  for (let trial = 0; trial < 3; trial += 1) {
    await page.evaluate(() => {
      window.__LATENT_SCOPE_FEED_CAROUSEL_DEBUG_EVENTS__ = []
    })

    await setCarouselScroll(1805)
    const beforeReveal = await revealStickyToc()
    await subclusterButton('Using emotions as information').click({ force: true })
    await wait(1000)
    const afterClick = await getState()
    const afterHide = await hideStickyToc()
    const state = { beforeReveal, afterClick, afterHide }
    resetTrials.push(state)

    assert(afterClick.scrollLeft !== null && afterClick.scrollLeft > 1200,
      'Sticky ToC subcluster click did not stay near the clicked cluster while hovered',
      state)
    assert(afterClick.isStickyVisible && afterClick.tocOpacity === '1',
      'Sticky ToC did not remain visible immediately after the subcluster click',
      state)
    assert(afterHide.scrollLeft !== null && afterHide.scrollLeft > 1200,
      'Sticky ToC subcluster click + mouse leave reset the carousel too far toward the start',
      state)
    assert(afterHide.isStickyShell && !afterHide.isStickyVisible,
      'Sticky ToC stayed pinned after pointer exit in reset regression check',
      state)
    assert(afterHide.activeText !== null && afterHide.activeText.includes('Pattern Consciousness'),
      'Active ToC cluster drifted away from the clicked cluster after sticky ToC exit',
      state)
  }

  await page.evaluate(() => {
    window.__LATENT_SCOPE_FEED_CAROUSEL_DEBUG_EVENTS__ = []
  })
  await setCarouselScroll(1805)
  await revealStickyToc()
  await subclusterButton('Using emotions as information').click({ force: true })
  await wait(1000)
  const hoveredState = await getState()
  assert(hoveredState.scrollLeft !== null && hoveredState.scrollLeft > 1200,
    'Hovered sticky ToC subcluster click did not land near the clicked cluster',
    hoveredState)
  assert(hoveredState.isStickyVisible,
    'Sticky ToC did not remain visible while the pointer stayed inside it',
    hoveredState)

  await hideStickyToc()
  const afterExitState = await getState()
  assert(afterExitState.scrollLeft !== null && afterExitState.scrollLeft > 1200,
    'Sticky ToC exit changed the carousel position after a successful subcluster jump',
    afterExitState)
  assert(afterExitState.isStickyShell && !afterExitState.isStickyVisible,
    'Sticky ToC did not collapse after pointer exit',
    afterExitState)

  await setCarouselScroll(1805)
  await revealStickyToc()
  await page.evaluate(() => {
    window.__LATENT_SCOPE_FEED_CAROUSEL_DEBUG_EVENTS__ = []
  })
  await page.evaluate(() => {
    const target = Array.from(document.querySelectorAll('div[class*="_list_"] > div > button'))
      .find((button) => button.innerText.includes('Applying ML to decode animal vocalizations'))
    target?.click()
  })
  await wait(1800)
  const firstTopicState = await getState()
  assert(firstTopicState.scrollLeft === 0,
    'First topic click did not return the strip to the true start',
    firstTopicState)
  assert(firstTopicState.tocLeft === 0 && firstTopicState.tocRight === 360,
    'First topic click did not fully restore ToC visibility',
    firstTopicState)

  await setCarouselScroll(1805)
  await revealStickyToc()
  await page.evaluate(() => {
    window.__LATENT_SCOPE_FEED_CAROUSEL_DEBUG_EVENTS__ = []
  })
  await page.evaluate(() => {
    document
      .querySelector('button[title="Descending"], button[title="Ascending"]')
      ?.click()
  })
  await wait(1000)
  const sortHoverState = await getState()
  assert(sortHoverState.isStickyVisible && sortHoverState.tocOpacity === '1',
    'Sort toggle while hovered caused the sticky ToC to collapse',
    sortHoverState)

  const summary = {
    url: page.url(),
    resetTrials,
    hoveredState,
    afterExitState,
    firstTopicState,
    sortHoverState,
  }

  console.log(JSON.stringify(summary, null, 2))
}
EOF

"$PLAYWRIGHT_CLI_BIN" -s="$SESSION_ID" run-code "$PLAYWRIGHT_CODE"
