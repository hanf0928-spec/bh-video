/* =========================================================
   BH Video — Ads module
   ---------------------------------------------------------
   Four kinds of ads are supported:
     1) Top banner ad      → image/gif at the top of the page
     2) Bottom banner ad   → image/gif at the bottom of the page
     3) Floating box ad    → fixed small image/gif in a corner
     4) Pre-roll video ad  → full-screen video that plays BEFORE
                             the main video.

   Pre-roll trigger rule (defaults: firstAfterEpisodes=5, everySeries=3):
     Phase 1 — No ad has ever fired yet:
       • Episodes #1..#5 of the FIRST series the viewer watches
         are ad-free.
       • Episode #6 of that same series triggers the FIRST ad.
     Phase 2 — The first ad has already fired:
       • Every `everySeries` NEW series opens triggers an ad.
       • Switching episodes within the same series never triggers
         an ad in phase 2.
     The ad overlay stays for `skipAfter` seconds, then the
     close/skip button becomes enabled.

   All configuration lives in `AD_CONFIG`. Replace the URLs there
   with real campaigns. Click targets open in a new tab.

   State is persisted in localStorage under `bhv.adState.v2` as a
   small JSON blob (see `readState()` for its shape). Bumping the
   `v2` suffix in STATE_KEY wipes it, so switching rule schemes in
   the future won't collide with user-side cached state.
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
    // Pre-roll ad shown on player.html.
    //
    // New rule (per product spec):
    //   • Phase 1 (first time ever in this browser)
    //       → the ad fires on the (`firstAfterEpisodes` + 1)-th episode
    //         opened. With `firstAfterEpisodes: 5` that's episode #6.
    //         Episodes 1..5 of the FIRST series the user watches are
    //         ad-free.
    //   • Phase 2 (after the first ad)
    //       → the ad fires once every `everySeries` NEW series. With
    //         `everySeries: 3` that's: open 3rd new series → ad,
    //         6th new series → ad, 9th → ad, …
    //
    // Switching episodes within the same series in phase 2 never
    // triggers an ad — only crossing to a brand-new series id counts.
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
      // Phase 1: fire the first-ever ad after this many ad-free
      // episodes within the first watched series.
      firstAfterEpisodes: 5,
      // Phase 2: after the first ad, fire again every N new series.
      everySeries: 3,
      label: "Iklan",
    },
  };

  // Storage keys. Bumping the version suffix wipes any state users
  // might carry from the older per-episode counter rule so they land
  // on the new (series-based) schedule cleanly.
  const STATE_KEY = "bhv.adState.v2";
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

  /* ---------- Pre-roll state helpers ---------- */

  /**
   * Persisted state shape (localStorage, JSON-encoded):
   *   {
   *     firstAdFired:        bool,      // has the first ad ever fired?
   *     firstSeriesId:       string,    // series the user is building
   *                                     // the phase-1 count against
   *     firstSeriesEpisodes: number,    // # of DISTINCT episodes watched
   *                                     // in that series
   *     lastSeriesId:        string,    // last series we've seen an
   *                                     // episode of (phase 2 series-
   *                                     // change detection)
   *     seriesSinceLastAd:   number,    // # of NEW series opened since
   *                                     // the last ad (phase 2)
   *   }
   */
  function readState() {
    try {
      const raw = localStorage.getItem(STATE_KEY);
      if (!raw) return newState();
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return newState();
      return {
        firstAdFired: !!parsed.firstAdFired,
        firstSeriesId: String(parsed.firstSeriesId || ""),
        firstSeriesEpisodes: Math.max(0, Number(parsed.firstSeriesEpisodes) || 0),
        lastSeriesId: String(parsed.lastSeriesId || ""),
        seriesSinceLastAd: Math.max(0, Number(parsed.seriesSinceLastAd) || 0),
      };
    } catch (_) {
      return newState();
    }
  }
  function newState() {
    return {
      firstAdFired: false,
      firstSeriesId: "",
      firstSeriesEpisodes: 0,
      lastSeriesId: "",
      seriesSinceLastAd: 0,
    };
  }
  function writeState(st) {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(st));
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
   * Called by player.js every time a new episode is opened. Decides
   * whether a pre-roll ad should play BEFORE this episode and
   * atomically updates the persisted state.
   *
   * Rule (defaults: firstAfterEpisodes=5, everySeries=3):
   *
   *   PHASE 1 — No ad has ever fired yet.
   *     • We tally DISTINCT episodes watched inside the FIRST series
   *       the user opens.
   *     • Episode #1..#5 of that series → no ad.
   *     • Episode #6 (i.e. right after they've "finished 5 episodes")
   *       → trigger the first ad.
   *     • If the user bounces to a different series before hitting
   *       episode 6, we RESET the tally against the new series — in
   *       other words, phase 1's rule is really "once some series
   *       crosses 5 completed episodes, show the ad".
   *
   *   PHASE 2 — The first ad has fired.
   *     • We count new series the user opens (one unit per switch).
   *     • Every `everySeries` series opens → trigger an ad.
   *     • Switching between episodes within the same series does
   *       NOT advance the counter.
   *
   * Returns `true` if the pre-roll should play BEFORE this episode.
   */
  function notifyEpisodeOpen(seriesId, epNum) {
    if (!seriesId || !epNum) return false;
    const key = seriesId + ":" + epNum;
    // Same episode reload — don't advance any counter, don't re-fire.
    if (readLastKey() === key) return false;
    writeLastKey(key);

    const cfg = AD_CONFIG.preRoll;
    if (!cfg || !cfg.enabled) return false;

    const firstAfter = Math.max(0, Number(cfg.firstAfterEpisodes) || 0);
    const everyN = Math.max(1, Number(cfg.everySeries) || 1);

    const st = readState();
    let fireAd = false;

    if (!st.firstAdFired) {
      // -------- PHASE 1 ---------
      if (st.firstSeriesId !== seriesId) {
        // User switched to a new series before hitting the threshold —
        // start tracking the new one from scratch.
        st.firstSeriesId = seriesId;
        st.firstSeriesEpisodes = 1;
      } else {
        st.firstSeriesEpisodes += 1;
      }
      // Episode (firstAfter + 1) is the one that triggers the ad:
      //   • firstAfter=5 → episode 6 triggers.
      // "Episode" here = "the Nth DISTINCT episode of this series
      // we've seen", not necessarily ep.ep (user could skip around).
      if (st.firstSeriesEpisodes > firstAfter) {
        fireAd = true;
        st.firstAdFired = true;
        // Prime phase-2 counters so the next ad doesn't fire until N
        // *new* series after this one.
        st.lastSeriesId = seriesId;
        st.seriesSinceLastAd = 0;
      }
    } else {
      // -------- PHASE 2 ---------
      if (st.lastSeriesId !== seriesId) {
        // User crossed into a brand-new series.
        st.lastSeriesId = seriesId;
        st.seriesSinceLastAd += 1;
        if (st.seriesSinceLastAd >= everyN) {
          fireAd = true;
          st.seriesSinceLastAd = 0;
        }
      }
      // else: still inside the current series → no advance, no ad.
    }

    writeState(st);
    return fireAd;
  }

  /** Current debug snapshot of the ad state. */
  function episodeCount() {
    return readState();
  }

  /** Dev helper — manually reset all ad-rule bookkeeping. */
  function resetCounter() {
    writeState(newState());
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
    const payload = JSON.stringify({ slot: slot, event: event });
    try {
      // Prefer sendBeacon: it fires-and-forgets without blocking the
      // page or waiting on the server, so a slow /api/ads/track can
      // never stall navigation or the 15s fetch timeout. The endpoint
      // answers in <1ms (in-memory counter + async disk flush), so the
      // beacon reliably lands even on page unload.
      if (navigator.sendBeacon) {
        const blob = new Blob([payload], { type: "application/json" });
        if (navigator.sendBeacon("/api/ads/track", blob)) return;
      }
    } catch (_) {
      /* fall through to fetch */
    }
    // Fallback for browsers without sendBeacon — non-blocking, silent.
    try {
      fetch("/api/ads/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
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
      "aria-label": "Tutup Iklan",
    });
    attachCountdownClose(closeBtn, wrap, BANNER_SKIP_AFTER);

    const tag = createEl("span", "bhv-ad-tag");
    tag.textContent = "Iklan";

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
      "aria-label": "Tutup Iklan",
    });
    attachCountdownClose(closeBtn, wrap, BANNER_SKIP_AFTER);

    const tag = createEl("span", "bhv-ad-tag");
    tag.textContent = "Iklan";

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
      "aria-label": "Iklan",
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
      label.textContent = cfg.label || "Iklan";

      // Close/skip button — stays disabled for the first `skipAfter`
      // seconds, then becomes clickable so the viewer can dismiss the
      // ad even if the ad video is longer than that window.
      const skipBtn = createEl("button", "bhv-ad-preroll-skip", {
        type: "button",
      });
      skipBtn.disabled = true;
      const skipAfter = Math.max(0, Number(cfg.skipAfter) || 0);
      skipBtn.textContent =
        skipAfter > 0 ? `Tutup dalam ${skipAfter}s` : "Tutup Iklan ›";

      const learnBtn = createEl("button", "bhv-ad-preroll-cta", {
        type: "button",
      });
      learnBtn.textContent = "Pelajari ›";
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
          alt: cfg.label || "Iklan",
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
      // clicks "Tutup Iklan".

      // Enable the close button after `skipAfter` seconds. The ad
      // continues to play; the user just decides when to dismiss.
      let remaining = skipAfter;
      let timer = null;
      if (remaining <= 0) {
        skipBtn.disabled = false;
        skipBtn.textContent = "Tutup Iklan ›";
      } else {
        timer = setInterval(() => {
          remaining -= 1;
          if (remaining <= 0) {
            clearInterval(timer);
            timer = null;
            skipBtn.disabled = false;
            skipBtn.textContent = "Tutup Iklan ›";
          } else {
            skipBtn.textContent = `Tutup dalam ${remaining}s`;
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
