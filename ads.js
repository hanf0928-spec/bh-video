/* =========================================================
   BH Video — Ads module
   ---------------------------------------------------------
   Four kinds of ads are supported:
     1) Top banner ad      → image/gif at the top of the page
     2) Bottom banner ad   → image/gif at the bottom of the page
     3) Floating box ad    → fixed small image/gif in a corner
     4) Pre-roll video ad  → full-screen video that plays BEFORE
                             the main video. Trigger rule:
                               • first `warmupEpisodes` episodes in
                                 the browser are ad-free;
                               • after that, an ad plays every
                                 `everyEpisodes` episodes.
                             Default: warmup=5, every=3 → ads fire on
                             the 6th, 9th, 12th, 15th… episode opens.
                             The ad overlay stays for `skipAfter`
                             seconds, then the close/skip button is
                             enabled.

   All configuration lives in `AD_CONFIG`. Replace the URLs there
   with real campaigns. Click targets open in a new tab.

   The episode counter is persisted in localStorage under
   `bhv.adEpisodeCount`. It is incremented every time player.js
   opens a NEW episode via BHAds.notifyEpisodeOpen() (same-episode
   refreshes do not count).
   ========================================================= */

(function () {
  "use strict";

  /** ----- Public configuration ----- */
  const AD_CONFIG = {
    // Top banner (home + player page). Set `enabled:false` to hide.
    topBanner: {
      enabled: true,
      // Use a GIF or static PNG/JPG/WebP.
      image:
        "https://picsum.photos/seed/bh-top-ad/1600/160",
      clickUrl: "https://example.com/campaign/top",
      alt: "顶部广告 Top Banner Ad",
    },
    // Bottom banner (home + player page).
    bottomBanner: {
      enabled: true,
      image:
        "https://picsum.photos/seed/bh-bottom-ad/1600/160",
      clickUrl: "https://example.com/campaign/bottom",
      alt: "底部广告 Bottom Banner Ad",
    },
    // Floating box ad — small ad pinned to a corner.
    floatingBox: {
      enabled: true,
      image: "https://picsum.photos/seed/bh-float-ad/300/300",
      clickUrl: "https://example.com/campaign/float",
      alt: "悬浮广告 Floating Ad",
      position: "bottom-right", // bottom-right | bottom-left | top-right | top-left
      width: 200,
      height: 200,
    },
    // Pre-roll ad shown on player.html. Rule:
    //   • the first `warmupEpisodes` episodes opened in this browser
    //     are ad-free (grace period for new viewers);
    //   • after the grace period, an ad plays every `everyEpisodes`
    //     episodes.
    // With warmup=5 + every=3 the ad fires on the 6th, 9th, 12th,
    // 15th… episode opens.
    preRoll: {
      enabled: true,
      video:
        "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
      // Fallback image shown when the video fails to load (CDN blocked,
      // 404, unsupported codec, etc.). Can be a GIF or static image.
      // Leave empty to fall back to the top-banner creative.
      fallbackImage: "https://picsum.photos/seed/bh-preroll-ad/960/540",
      clickUrl: "https://example.com/campaign/preroll",
      // Ad must stay on screen at least this many seconds; after
      // that the close/skip button becomes clickable.
      skipAfter: 5,
      // Ad-free grace period at the start of a browser session.
      warmupEpisodes: 5,
      // Trigger an ad once every N episodes AFTER the grace period.
      everyEpisodes: 3,
      label: "广告 · Ad",
    },
  };

  const COUNTER_KEY = "bhv.adEpisodeCount";
  const LAST_EP_KEY = "bhv.adLastEpisodeKey";

  /**
   * How long (in seconds) the top/bottom banner and floating-box ads
   * must stay on screen before the user can tap the "×" close button.
   * Pre-roll uses its own `AD_CONFIG.preRoll.skipAfter` because it's
   * a full-screen takeover.
   */
  const BANNER_SKIP_AFTER = 5;

  /**
   * Attach a 5-second countdown onto a banner/floating-box close
   * button. For the first `seconds` seconds the button shows the
   * remaining time (e.g. "5" → "4" → "3"), is visually locked and
   * ignores clicks. Afterwards it switches to the regular "×" and
   * becomes clickable; tapping it removes `wrap` from the DOM.
   */
  function attachCountdownClose(btn, wrap, seconds) {
    const total = Math.max(0, Number(seconds) || 0);
    let remaining = total;

    btn.classList.add("bhv-ad-close--countdown");
    btn.textContent = total > 0 ? String(total) : "×";
    btn.disabled = total > 0;

    let timer = null;
    if (total > 0) {
      timer = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          clearInterval(timer);
          timer = null;
          btn.textContent = "×";
          btn.disabled = false;
          btn.classList.remove("bhv-ad-close--countdown");
        } else {
          btn.textContent = String(remaining);
        }
      }, 1000);
    } else {
      btn.classList.remove("bhv-ad-close--countdown");
    }

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      if (timer) { clearInterval(timer); timer = null; }
      try { wrap.remove(); } catch (_) {}
    });
  }

  /* ---------- Episode counter helpers ---------- */

  function readCounter() {
    try {
      const n = parseInt(localStorage.getItem(COUNTER_KEY) || "0", 10);
      return isFinite(n) && n >= 0 ? n : 0;
    } catch (_) {
      return 0;
    }
  }
  function writeCounter(n) {
    try {
      localStorage.setItem(COUNTER_KEY, String(n));
    } catch (_) {
      /* storage disabled — ignore */
    }
  }
  function readLastKey() {
    try {
      return localStorage.getItem(LAST_EP_KEY) || "";
    } catch (_) {
      return "";
    }
  }
  function writeLastKey(k) {
    try {
      localStorage.setItem(LAST_EP_KEY, k || "");
    } catch (_) {}
  }

  /**
   * Called by player.js every time a new episode is opened. Increments
   * the global counter but only when the (series, ep) pair changes so
   * refreshing the same episode doesn't inflate the count.
   *
   * Trigger rule (warmup=5, every=3 by default):
   *   • episodes 1..5           → NO ad (grace period)
   *   • episode 6               → AD (first episode after warmup)
   *   • episodes 7, 8           → no ad
   *   • episode 9               → AD
   *   • episodes 10, 11         → no ad
   *   • episode 12              → AD, and so on every 3 episodes.
   *
   * Returns `true` if the pre-roll should play BEFORE this episode.
   */
  function notifyEpisodeOpen(seriesId, epNum) {
    const key = seriesId + ":" + epNum;
    if (!seriesId || !epNum) return false;
    if (readLastKey() === key) return false; // same episode reload
    writeLastKey(key);
    const nextCount = readCounter() + 1;
    writeCounter(nextCount);

    const cfg = AD_CONFIG.preRoll;
    if (!cfg.enabled) return false;

    const warmup = Math.max(0, Number(cfg.warmupEpisodes) || 0);
    const every = Math.max(1, Number(cfg.everyEpisodes) || 1);

    // Still inside the ad-free grace period.
    if (nextCount <= warmup) return false;

    // Position within the post-warmup window: 1 means first episode
    // after warmup (which should trigger), 2 is the next, etc.
    const postIndex = nextCount - warmup;
    return (postIndex - 1) % every === 0;
  }

  /** Current counter (for debugging / UI badges). */
  function episodeCount() {
    return readCounter();
  }

  /** Dev helper — manually reset the counter. */
  function resetCounter() {
    writeCounter(0);
    writeLastKey("");
  }

  /* ---------- DOM injection ---------- */

  function createEl(tag, cls, attrs) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (attrs) {
      Object.keys(attrs).forEach((k) => el.setAttribute(k, attrs[k]));
    }
    return el;
  }

  function openInNewTab(url) {
    if (!url) return;
    window.open(url, "_blank", "noopener");
  }

  /**
   * Fire-and-forget telemetry — reports an ad impression / click to
   * the backend so the admin dashboard can aggregate CTRs.
   * Known slots: top | bottom | float | preroll | preroll_cta.
   */
  function trackAd(slot, event) {
    if (!slot || !event) return;
    try {
      fetch("/api/ads/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slot: slot, event: event }),
        keepalive: true,
      }).catch(() => {});
    } catch (_) {
      /* fetch unavailable — ignore */
    }
  }

  /** Build a banner node (top or bottom). */
  function buildBanner(cfg, position) {
    const wrap = createEl(
      "div",
      "bhv-ad bhv-ad-banner bhv-ad-banner--" + position,
      { "data-ad-slot": position }
    );
    const img = createEl("img", "bhv-ad-img", {
      src: cfg.image,
      alt: cfg.alt || "ad",
      loading: "lazy",
    });
    img.addEventListener("click", () => {
      trackAd(position, "click");
      openInNewTab(cfg.clickUrl);
    });
    img.style.cursor = cfg.clickUrl ? "pointer" : "default";

    // Close button: locked for `BANNER_SKIP_AFTER` seconds, then clickable.
    const closeBtn = createEl("button", "bhv-ad-close", {
      type: "button",
      "aria-label": "关闭广告",
    });
    attachCountdownClose(closeBtn, wrap, BANNER_SKIP_AFTER);

    const tag = createEl("span", "bhv-ad-tag");
    tag.textContent = "广告 · Ad";

    wrap.appendChild(img);
    wrap.appendChild(tag);
    wrap.appendChild(closeBtn);
    return wrap;
  }

  /** Build the floating corner ad. */
  function buildFloatingBox(cfg) {
    const wrap = createEl(
      "div",
      "bhv-ad bhv-ad-float bhv-ad-float--" + (cfg.position || "bottom-right"),
      { "data-ad-slot": "float" }
    );
    wrap.style.width = (cfg.width || 200) + "px";

    const img = createEl("img", "bhv-ad-img", {
      src: cfg.image,
      alt: cfg.alt || "ad",
      loading: "lazy",
    });
    img.style.width = "100%";
    img.style.height = (cfg.height || 200) + "px";
    img.style.cursor = cfg.clickUrl ? "pointer" : "default";
    img.addEventListener("click", () => {
      trackAd("float", "click");
      openInNewTab(cfg.clickUrl);
    });

    // Close button: locked for `BANNER_SKIP_AFTER` seconds, then clickable.
    const closeBtn = createEl("button", "bhv-ad-close", {
      type: "button",
      "aria-label": "关闭广告",
    });
    attachCountdownClose(closeBtn, wrap, BANNER_SKIP_AFTER);

    const tag = createEl("span", "bhv-ad-tag");
    tag.textContent = "广告 · Ad";

    wrap.appendChild(img);
    wrap.appendChild(tag);
    wrap.appendChild(closeBtn);
    return wrap;
  }

  /** Attach banners + floating box into the DOM. */
  function mountStaticAds() {
    const body = document.body;
    if (!body) return;

    if (AD_CONFIG.topBanner.enabled) {
      const top = buildBanner(AD_CONFIG.topBanner, "top");
      // Insert as the FIRST child of <body> so it sits above the sticky
      // header. The header is sticky with top:0 — the banner scrolls
      // away naturally.
      body.insertBefore(top, body.firstChild);
      trackAd("top", "impression");
    }

    if (AD_CONFIG.bottomBanner.enabled) {
      const bottom = buildBanner(AD_CONFIG.bottomBanner, "bottom");
      // Insert just before the footer so it visually belongs to the
      // bottom of the content area.
      const footer = document.querySelector(".site-footer");
      if (footer && footer.parentNode) {
        footer.parentNode.insertBefore(bottom, footer);
      } else {
        body.appendChild(bottom);
      }
      trackAd("bottom", "impression");
    }

    if (AD_CONFIG.floatingBox.enabled) {
      const float = buildFloatingBox(AD_CONFIG.floatingBox);
      body.appendChild(float);
      trackAd("float", "impression");
    }
  }

  /* ---------- Pre-roll overlay ---------- */

  /**
   * Show a full-screen pre-roll ad. Resolves (true) when the ad
   * finishes OR user skips. Resolves (false) if ad is misconfigured.
   */
  function playPreRoll() {
    return new Promise((resolve) => {
      const cfg = AD_CONFIG.preRoll;
      if (!cfg || !cfg.enabled || !cfg.video) {
        resolve(false);
        return;
      }

      const overlay = createEl("div", "bhv-ad-preroll", {
        role: "dialog",
        "aria-label": "广告",
      });

      const inner = createEl("div", "bhv-ad-preroll-inner");

      const video = document.createElement("video");
      video.className = "bhv-ad-preroll-video";
      video.src = cfg.video;
      video.autoplay = true;
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      // Start muted so the browser doesn't block autoplay. The ad still
      // runs; audio restrictions on autoplay are standard in Chrome/Safari.
      video.muted = true;
      video.setAttribute("muted", "");
      video.loop = true; // keep showing even if the clip is very short
      video.controls = false;
      // Click on the ad video → open the campaign URL.
      video.style.cursor = cfg.clickUrl ? "pointer" : "default";
      video.addEventListener("click", (e) => {
        // Avoid intercepting clicks on explicit controls.
        if (e.target !== video) return;
        trackAd("preroll", "click");
        openInNewTab(cfg.clickUrl);
      });

      const label = createEl("div", "bhv-ad-preroll-label");
      label.textContent = cfg.label || "广告 · Ad";

      // Close/skip button — stays disabled for the first `skipAfter`
      // seconds, then becomes clickable so the viewer can dismiss the
      // ad even if the ad video is longer than that window.
      const skipBtn = createEl("button", "bhv-ad-preroll-skip", {
        type: "button",
      });
      skipBtn.disabled = true;
      const skipAfter = Math.max(0, Number(cfg.skipAfter) || 0);
      skipBtn.textContent =
        skipAfter > 0 ? `${skipAfter}s 后可关闭` : "关闭广告 ›";

      const learnBtn = createEl("button", "bhv-ad-preroll-cta", {
        type: "button",
      });
      learnBtn.textContent = "了解详情 ›";
      learnBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        trackAd("preroll_cta", "click");
        openInNewTab(cfg.clickUrl);
      });

      let finished = false;
      function done() {
        if (finished) return;
        finished = true;
        try {
          video.pause();
        } catch (_) {}
        overlay.remove();
        resolve(true);
      }

      skipBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!skipBtn.disabled) done();
      });

      // If the ad video fails to load (CDN blocked, 404, format
      // unsupported, etc.), DON'T auto-close — swap in a fallback
      // image/poster so the viewer still sees the ad for the full
      // `skipAfter` seconds. The close button will still appear on
      // schedule and the user can dismiss it manually.
      function fallbackToImage() {
        if (finished) return;
        // Prefer a configured fallback image; otherwise reuse the top
        // banner creative as a last resort so the slot isn't blank.
        const fallbackSrc =
          cfg.fallbackImage ||
          (AD_CONFIG.topBanner && AD_CONFIG.topBanner.image) ||
          "";
        if (!fallbackSrc) return;
        const img = createEl("img", "bhv-ad-preroll-video", {
          src: fallbackSrc,
          alt: cfg.label || "广告",
        });
        img.style.cursor = cfg.clickUrl ? "pointer" : "default";
        img.addEventListener("click", () => {
          trackAd("preroll", "click");
          openInNewTab(cfg.clickUrl);
        });
        if (video.parentNode) {
          video.parentNode.replaceChild(img, video);
        }
      }

      video.addEventListener("error", fallbackToImage);
      // Note: we intentionally do NOT bind `ended` to `done()`. With
      // `video.loop = true` the video keeps playing until the user
      // clicks "关闭广告".

      // Enable the close button after `skipAfter` seconds. The ad
      // continues to play; the user just decides when to dismiss.
      let remaining = skipAfter;
      let timer = null;
      if (remaining <= 0) {
        skipBtn.disabled = false;
        skipBtn.textContent = "关闭广告 ›";
      } else {
        timer = setInterval(() => {
          remaining -= 1;
          if (remaining <= 0) {
            clearInterval(timer);
            timer = null;
            skipBtn.disabled = false;
            skipBtn.textContent = "关闭广告 ›";
          } else {
            skipBtn.textContent = `${remaining}s 后可关闭`;
          }
        }, 1000);
      }

      inner.appendChild(video);
      inner.appendChild(label);
      inner.appendChild(learnBtn);
      inner.appendChild(skipBtn);
      overlay.appendChild(inner);
      document.body.appendChild(overlay);
      trackAd("preroll", "impression");

      // Some browsers need an explicit play() after mount. If it fails
      // we fall back to a static image but keep the overlay up.
      const p = video.play();
      if (p && typeof p.catch === "function") {
        p.catch(() => {
          fallbackToImage();
        });
      }
    });
  }

  /* ---------- Boot ---------- */

  function boot() {
    mountStaticAds();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  // Public API exposed to player.js
  window.BHAds = {
    config: AD_CONFIG,
    notifyEpisodeOpen,
    playPreRoll,
    episodeCount,
    resetCounter,
  };
})();
