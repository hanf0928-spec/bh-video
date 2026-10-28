/* =========================================================
   BH Video — Home page (immersive vertical feed, "红果" style)
   -----------------------------------------------------------
   Behaviour summary:
   - The home page is a full-screen vertical feed. Each snap
     "card" occupies 100vw × 100vh and represents ONE series.
   - Users swipe up/down to move between series (CSS scroll-snap
     + IntersectionObserver).
   - The active card AUTO-PLAYS episode 1 as a muted preview. On
     tap, we hand off to player.html with the current playback
     time so the viewer keeps watching from the exact second.
   - If the preview finishes episode 1 in the feed, we also hand
     off to player.html at ep=2 so the next episode starts
     playing automatically in the dedicated player page.
   - Episodes src URLs are hydrated LAZILY from
     /api/library/<id> only when a card first becomes active —
     the initial catalog response stays small.
   - Right-side action rail: ❤ like (persisted on the backend
     per IP), 🔗 share deep-link, ☰ episode picker.
   - A top-right floating button acts as "back to home" — it
     scrolls the feed back to the very first series.
   - Search still works: tapping the magnifier opens an overlay
     list that filters series by title/tag; picking a result
     scrolls the feed to that series.
   ========================================================= */

(function () {
  "use strict";

  const Catalog = window.VideoCatalog;
  const feedEl = document.getElementById("feed");
  const emptyEl = document.getElementById("feedEmpty");
  const searchInput = document.getElementById("searchInput");
  const searchBtn = document.getElementById("searchBtn");
  const searchResults = document.getElementById("searchResults");
  const searchToggleBtn = document.getElementById("feedSearchBtn");
  const searchPanel = document.getElementById("feedSearchPanel");

  // Latest play counts from the backend. Shape:
  //   { "<seriesId>:ep<n>": { opens, plays, ends } }
  let playStats = {};

  // Likes state keyed by seriesId. Shape:
  //   { "<seriesId>": { count: number, liked: boolean } }
  // Hydrated once on boot from /api/likes, and updated in place on
  // every toggle so the UI stays in sync without a full refresh.
  const likesState = new Map();

  // In-flight episode source hydration promises. Keyed by seriesId
  // so simultaneous activations don't duplicate requests.
  const seriesSrcCache = new Map();

  // Per-series feed state. Map<seriesId, { currentEp, played: Set<n> }>
  // We keep this at module scope so re-entering a card remembers which
  // episode the user was last watching inside this tab.
  const feedState = new Map();

  const i18n = window.I18N || {
    t: (k) => k,
    pickLocalized: (v, f) => (v ? v[f] : ""),
    localizeCategory: (c) => c,
    onChange: () => () => {},
  };
  const t = (k, p) => i18n.t(k, p);

  function getSeriesList() {
    return window.VIDEOS || [];
  }

  /* ---------- API ---------- */

  function fetchLibrary() {
    // Use the lightweight catalog endpoint on the home feed. It drops
    // the per-episode signed URLs (which balloon the payload to several
    // MB once 50+ series are imported) and keeps everything a card
    // actually needs: title, cover, episode count, tags, description…
    // Signed URLs for a specific drama are fetched later, on-demand,
    // when the user opens the player page.
    return fetch("/api/library/catalog", {
      headers: { Accept: "application/json" },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && Array.isArray(data.imported)) {
          Catalog.mergeImported(data.imported);
        }
      })
      .catch(() => {});
  }

  function fetchPlayStats() {
    return fetch("/api/stats", { headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : {}))
      .then((data) => {
        playStats = data && typeof data === "object" ? data : {};
      })
      .catch(() => {
        playStats = {};
      });
  }

  /**
   * Pull the current likes snapshot. The server also tells us whether
   * the caller's IP has already liked each series, so we can paint the
   * heart red on first paint without a round-trip from the user.
   */
  function fetchLikes() {
    return fetch("/api/likes", { headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : {}))
      .then((data) => {
        likesState.clear();
        if (data && typeof data === "object") {
          Object.keys(data).forEach((sid) => {
            const entry = data[sid] || {};
            likesState.set(sid, {
              count: Number(entry.count) || 0,
              liked: !!entry.liked_by_me,
            });
          });
        }
      })
      .catch(() => {});
  }

  /**
   * Register a like for a series. ONE-WAY: once a visitor has liked a
   * series, further taps are a no-op (both locally and on the server).
   * Spec: "爱心点过后不可取消，每个用户每部作品只能点一次"。
   *
   * We optimistically bump the UI, fire the request, then reconcile
   * with the server's authoritative count (handles cases where other
   * viewers liked the same series concurrently).
   */
  /**
   * Register a like tap for a series. Simplified, additive model:
   *   • every tap increments the counter by 1 (fire-and-forget);
   *   • no "one like per user" check — anyone can tap as many times
   *     as they like, each tap adds 1;
   *   • the red heart is a PURELY LOCAL visual: once THIS browser has
   *     tapped, it stays red for the session, but it is NOT persisted
   *     server-side and resets on refresh (the server only stores a
   *     global count, not "who liked").
   *
   * We optimistically bump the UI, fire the request, then reconcile
   * with the server's authoritative count (handles other viewers
   * tapping the same series concurrently).
   */
  function toggleLike(seriesId, likeBtn, labelEl) {
    if (!seriesId) return;
    const prev = likesState.get(seriesId) || { count: 0, liked: false };
    const next = { count: prev.count + 1, liked: true };
    likesState.set(seriesId, next);
    paintLike(likeBtn, labelEl, next);

    fetch("/api/likes/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: seriesId }),
      keepalive: true,
    })
      .then((r) => (r && r.ok ? r.json() : null))
      .then((data) => {
        if (!data || !data.ok) return;
        const authoritative = {
          count: Number(data.count) || 0,
          liked: true,
        };
        likesState.set(seriesId, authoritative);
        paintLike(likeBtn, labelEl, authoritative);
      })
      .catch(() => {});
  }

  /**
   * Apply visual state (red heart + numeric label) to a like button.
   * The red state is driven by the local `liked` flag (set on tap in
   * this session); it is intentionally NOT disabled, so repeated taps
   * keep incrementing the counter.
   */
  function paintLike(btn, label, state) {
    if (!btn) return;
    const liked = !!(state && state.liked);
    btn.classList.toggle("liked", liked);
    if (liked) btn.setAttribute("aria-pressed", "true");
    else btn.removeAttribute("aria-pressed");
    if (label) label.textContent = formatCount((state && state.count) || 0);
  }

  /**
   * The catalog endpoint strips per-episode `src` URLs to keep the
   * home feed payload tiny. When a card first becomes active we need
   * the real URL to actually auto-play, so we lazily fetch the full
   * series detail here. Results are cached per series for the lifetime
   * of the page so repeated activations don't refetch.
   */
  function hydrateSeriesSrc(seriesId) {
    if (!seriesId) return Promise.resolve(null);
    const series = Catalog.findSeries(seriesId);
    const firstEp = series && (series.episodes || [])[0];
    if (firstEp && firstEp.src) {
      // Already have the src — nothing to do.
      return Promise.resolve(series);
    }
    const cached = seriesSrcCache.get(seriesId);
    if (cached) return cached;
    const p = fetch("/api/library/" + encodeURIComponent(seriesId), {
      headers: { Accept: "application/json" },
    })
      .then((r) => (r && r.ok ? r.json() : null))
      .then((data) => {
        if (data && data.series) {
          Catalog.mergeImported([data.series]);
          return Catalog.findSeries(seriesId);
        }
        return null;
      })
      .catch(() => null);
    seriesSrcCache.set(seriesId, p);
    return p;
  }

  function reportStat(seriesId, ep, event) {
    if (!seriesId || !ep || !event) return;
    const id = Catalog.episodeKey(seriesId, ep);
    try {
      fetch("/api/stats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, event }),
        keepalive: true,
      })
        .then((r) => (r && r.ok ? r.json() : null))
        .then((data) => {
          if (data && data.ok && data.stats) {
            playStats[id] = data.stats;
          }
        })
        .catch(() => {});
    } catch (_) {}
  }

  /* ---------- Formatting ---------- */

  function formatCount(n) {
    const num = Number(n) || 0;
    if (num >= 1_000_000)
      return (num / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
    if (num >= 1_000) return (num / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
    return String(num);
  }

  function parseViewsLabel(label) {
    if (label == null) return 0;
    const s = String(label).trim().toUpperCase();
    const m = s.match(/^([\d.]+)\s*([KM]?)$/);
    if (!m) return Number(s) || 0;
    const n = parseFloat(m[1]);
    if (!isFinite(n)) return 0;
    if (m[2] === "M") return Math.round(n * 1_000_000);
    if (m[2] === "K") return Math.round(n * 1_000);
    return Math.round(n);
  }

  function seriesTotalPlays(series) {
    if (!series || !Array.isArray(series.episodes)) return 0;
    let total = 0;
    series.episodes.forEach((ep) => {
      const key = Catalog.episodeKey(series.id, ep.ep);
      const stat = playStats && playStats[key];
      if (stat && typeof stat.plays === "number" && stat.plays > 0) {
        total += stat.plays;
      } else if (ep.views) {
        total += parseViewsLabel(ep.views);
      }
    });
    return total;
  }

  /* ---------- Feed rendering ---------- */

  /**
   * Build a single feed item: a 100vw × 100vh card.
   *
   * KEY PERFORMANCE NOTE: the card is intentionally LIGHT at build
   * time — just a poster <img>, static overlays, and a hidden
   * <video> placeholder. The actual <video> element is **lazily
   * mounted** when the card scrolls into view (see activateItem()),
   * and torn down when it scrolls out, so a 50-series feed only
   * ever has ONE live <video> in the DOM.
   *
   * The home feed is a preview surface — all playback goes through
   * player.html — so a plain <img> is more than enough.
   */
  function buildFeedItem(series, index) {
    const title = i18n.pickLocalized(series, "title");
    const desc = i18n.pickLocalized(series, "description");
    const tags = Array.isArray(series.tags) ? series.tags.slice(0, 3) : [];
    const epCount = (series.episodes || []).length;
    const firstEp = (series.episodes || [])[0];
    const poster = (firstEp && firstEp.thumbnail) || series.thumbnail || "";
    const likeInfo = likesState.get(series.id) || { count: 0, liked: false };

    const item = document.createElement("section");
    item.className = "feed-item";
    item.dataset.seriesId = series.id;
    item.dataset.index = String(index);

    item.innerHTML = `
      <!-- Preview video. src is injected lazily when the card becomes
           active (see activateItem()), so the first-screen render
           doesn't fetch 50 video streams at once. -->
      <video class="feed-video"
             playsinline webkit-playsinline
             preload="none"
             muted
             loop
             poster="${escapeAttr(poster)}"
             data-series-id="${escapeAttr(series.id)}"></video>

      <!-- Dark gradient so overlays stay readable on any poster -->
      <div class="feed-gradient"></div>

      <!-- Big center play icon — shown while paused only, as a
           persistent "tap to open player" hint. -->
      <button class="feed-playpause" type="button" aria-label="Putar">
        <svg class="icon-play" viewBox="0 0 24 24" width="56" height="56" fill="#fff">
          <path d="M8 5v14l11-7z"></path>
        </svg>
      </button>

      <!-- Right-side action rail (like / share / episode picker) -->
      <div class="feed-side">
        <button class="feed-side-btn feed-like${
          likeInfo.liked ? " liked" : ""
        }" type="button" aria-label="Suka">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none"
               stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
          </svg>
          <span class="feed-side-label" data-like-count>${escapeHtml(
            formatCount(likeInfo.count)
          )}</span>
        </button>

        <button class="feed-side-btn feed-share" type="button" aria-label="Bagikan">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none"
               stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round">
            <circle cx="18" cy="5" r="3"></circle>
            <circle cx="6" cy="12" r="3"></circle>
            <circle cx="18" cy="19" r="3"></circle>
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
          </svg>
          <span class="feed-side-label">Bagikan</span>
        </button>

        <button class="feed-side-btn feed-ep-picker" type="button" aria-label="Daftar Episode">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none"
               stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="2"></rect>
            <line x1="3" y1="10" x2="21" y2="10"></line>
            <line x1="9" y1="4" x2="9" y2="20"></line>
          </svg>
          <span class="feed-side-label feed-ep-count">${escapeHtml(
            t("series.epCount", { n: epCount })
          )}</span>
        </button>
      </div>

      <!-- Bottom info: title / tags / description -->
      <div class="feed-info">
        <div class="feed-ep-indicator">
          <span class="feed-ep-chip" data-ep-chip>${escapeHtml(
            t("series.epShort", { n: 1 })
          )}</span>
          <span class="feed-ep-sep">·</span>
          <span class="feed-ep-total">${escapeHtml(
            t("series.epCount", { n: epCount })
          )}</span>
        </div>
        <h2 class="feed-title">${escapeHtml(title)}</h2>
        ${
          tags.length
            ? `<div class="feed-tags">${tags
                .map(
                  (tag) =>
                    `<span class="feed-tag">${escapeHtml(tag)}</span>`
                )
                .join("")}</div>`
            : ""
        }
        <p class="feed-desc">${escapeHtml(desc)}</p>
      </div>

      <!-- Progress bar (bottom edge of the card) -->
      <div class="feed-progress" aria-hidden="true">
        <div class="feed-progress-fill" data-progress></div>
      </div>
    `;
    return item;
  }

  /** Build the whole feed from the current series list. */
  function renderFeed() {
    const list = getSeriesList();
    if (!list.length) {
      feedEl.innerHTML = "";
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;

    const frag = document.createDocumentFragment();
    list.forEach((s, i) => frag.appendChild(buildFeedItem(s, i)));
    feedEl.innerHTML = "";
    feedEl.appendChild(frag);

    // Wire up every item.
    feedEl.querySelectorAll(".feed-item").forEach((item) => bindFeedItem(item));

    // Observe visibility so we can play the one in view.
    observeFeedItems();

    // Kick-off: start the first item explicitly (IntersectionObserver
    // sometimes fires late on initial load).
    const first = feedEl.querySelector(".feed-item");
    if (first) activateItem(first);
  }

  /* ---------- Per-item behaviour ---------- */

  function getItemState(seriesId) {
    let st = feedState.get(seriesId);
    if (!st) {
      st = { currentEp: 1, hasStarted: false };
      feedState.set(seriesId, st);
    }
    return st;
  }

  function episodeByNum(series, epNum) {
    if (!series || !Array.isArray(series.episodes)) return null;
    const num = Number(epNum);
    return (
      series.episodes.find((e) => Number(e.ep) === num) || series.episodes[0]
    );
  }

  /**
   * Hand off from the home feed to player.html, carrying over the
   * exact second the preview is at so playback feels seamless.
   *
   * Behaviour:
   *   • If the preview video has NOT finished → open ep=1 at t=<cur>.
   *   • If the preview video HAS finished (currentTime >= duration-0.5)
   *     → open ep=2 at t=0 so the viewer naturally sees the second
   *     episode. If there is no ep=2 we stay on ep=1.
   */
  function openPlayerForItem(item) {
    const seriesId = item.dataset.seriesId;
    if (!seriesId) return;
    const series = Catalog.findSeries(seriesId);
    const video = item.querySelector(".feed-video");
    const curTime = video ? Number(video.currentTime) || 0 : 0;
    const duration = video ? Number(video.duration) || 0 : 0;
    const finished = duration > 0 && curTime >= duration - 0.5;

    let targetEp = 1;
    let targetT = Math.max(0, Math.floor(curTime));

    if (finished) {
      const episodes = (series && series.episodes) || [];
      if (episodes.length >= 2) {
        targetEp = Number(episodes[1].ep) || 2;
      }
      targetT = 0;
    }

    // Fire-and-forget "open" telemetry. keepalive=true keeps it alive
    // across the imminent navigation.
    reportStat(seriesId, targetEp, "open");

    try { if (video) video.pause(); } catch (_) {}

    const url =
      "player.html?id=" + encodeURIComponent(seriesId) +
      "&ep=" + encodeURIComponent(targetEp) +
      (targetT > 0 ? "&t=" + encodeURIComponent(targetT) : "");
    window.location.href = url;
  }

  /** Bind one feed item's internal events (tap-to-open-player, side rail…). */
  function bindFeedItem(item) {
    const seriesId = item.dataset.seriesId;
    const series = Catalog.findSeries(seriesId);
    if (!series) return;

    const video = item.querySelector(".feed-video");
    const playBtn = item.querySelector(".feed-playpause");
    const likeBtn = item.querySelector(".feed-like");
    const likeLabel = likeBtn && likeBtn.querySelector("[data-like-count]");
    const shareBtn = item.querySelector(".feed-share");
    const epPicker = item.querySelector(".feed-ep-picker");
    const progress = item.querySelector("[data-progress]");

    // Tap on the video / center play icon → open the full player page
    // and continue from the exact current time (or episode 2 if the
    // preview has already finished).
    const openPlayer = () => openPlayerForItem(item);
    if (video) video.addEventListener("click", openPlayer);
    if (playBtn) {
      playBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openPlayer();
      });
    }

    // Progress bar sync — keeps the thin bar at the bottom in step
    // with the preview video.
    if (video && progress) {
      video.addEventListener("timeupdate", () => {
        const d = Number(video.duration) || 0;
        if (!d) return;
        const pct = (video.currentTime / d) * 100;
        progress.style.width = pct + "%";
      });
    }

    // Pause overlay toggle (dim center icon when playing).
    if (video) {
      video.addEventListener("play", () => item.classList.remove("is-paused"));
      video.addEventListener("pause", () => {
        if (!video.ended) item.classList.add("is-paused");
      });
      // When the preview finishes playing episode 1, auto-hand off to
      // player.html at ep=2 so the viewer keeps watching the next
      // episode without manual tapping.
      video.addEventListener("ended", () => {
        openPlayer();
      });
    }

    // Heart button → persist on the backend and reflect new state
    // instantly on the UI.
    if (likeBtn) {
      likeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleLike(seriesId, likeBtn, likeLabel);
      });
    }

    shareBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const url =
        location.origin +
        "/player.html?id=" + encodeURIComponent(series.id) + "&ep=1";
      if (navigator.share) {
        navigator.share({ title: series.title, url }).catch(() => {});
      } else if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(() => showToast(t("toast.linkCopied")));
      }
    });

    epPicker.addEventListener("click", (e) => {
      e.stopPropagation();
      openEpisodePicker(item, series);
    });
  }

  /* ---------- Visibility / scroll-snap orchestration ---------- */

  let feedObserver = null;

  function observeFeedItems() {
    if (feedObserver) {
      try { feedObserver.disconnect(); } catch (_) {}
    }
    // threshold 0.6 → an item needs to occupy >60% of the viewport
    // before it's considered "active". Prevents flicker during swipe.
    feedObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && entry.intersectionRatio > 0.6) {
            activateItem(entry.target);
          } else {
            deactivateItem(entry.target);
          }
        });
      },
      { root: feedEl, threshold: [0, 0.6, 1] }
    );
    feedEl.querySelectorAll(".feed-item").forEach((item) =>
      feedObserver.observe(item)
    );
  }

  function activateItem(item) {
    if (item.classList.contains("is-active")) return;
    feedEl.querySelectorAll(".feed-item.is-active").forEach((other) =>
      deactivateItem(other)
    );
    item.classList.add("is-active");

    const seriesId = item.dataset.seriesId;
    const video = item.querySelector(".feed-video");

    // One-shot "open" telemetry so dashboard counts matches reality
    // even when users just swipe through the home feed without tapping.
    if (!item.dataset.openReported) {
      item.dataset.openReported = "1";
      if (seriesId) reportStat(seriesId, 1, "open");
    }

    if (!seriesId || !video) return;

    // Lazy-hydrate the actual episode source once per series, then
    // start the muted preview.
    hydrateSeriesSrc(seriesId).then((series) => {
      // The user may have swiped past this card while we were loading.
      if (!item.classList.contains("is-active")) return;
      const firstEp = series && (series.episodes || [])[0];
      if (!firstEp || !firstEp.src) return;
      if (!video.src) {
        video.src = firstEp.src;
        video.load();
      }
      const p = video.play();
      if (p && typeof p.catch === "function") {
        p.catch(() => {
          // Autoplay blocked → leave the center play icon visible as
          // a hint; a tap still opens the full player page.
          item.classList.add("is-paused");
        });
      }
    });
  }

  function deactivateItem(item) {
    item.classList.remove("is-active");
    const video = item.querySelector(".feed-video");
    if (video) {
      try { video.pause(); } catch (_) {}
    }
  }

  /* ---------- Episode picker sheet ---------- */

  let epSheetEl = null;
  function openEpisodePicker(item, series) {
    if (epSheetEl) epSheetEl.remove();
    epSheetEl = document.createElement("div");
    epSheetEl.className = "feed-ep-sheet";
    epSheetEl.innerHTML = `
      <div class="feed-ep-sheet-inner">
        <div class="feed-ep-sheet-head">
          <h3>${escapeHtml(i18n.pickLocalized(series, "title"))}</h3>
          <button class="feed-ep-sheet-close" type="button" aria-label="Tutup">×</button>
        </div>
        <div class="feed-ep-sheet-grid">
          ${(series.episodes || [])
            .map((e) => {
              return `<button class="feed-ep-cell" data-ep="${escapeAttr(
                String(e.ep)
              )}">${escapeHtml(
                t("series.epShort", { n: e.ep })
              )}</button>`;
            })
            .join("")}
        </div>
      </div>
    `;
    document.body.appendChild(epSheetEl);
    requestAnimationFrame(() => epSheetEl.classList.add("open"));

    epSheetEl.addEventListener("click", (e) => {
      if (e.target === epSheetEl || e.target.closest(".feed-ep-sheet-close")) {
        closeEpisodePicker();
        return;
      }
      const cell = e.target.closest(".feed-ep-cell");
      if (!cell) return;
      const ep = Number(cell.dataset.ep);
      closeEpisodePicker();
      // Jump straight to the player page at the picked episode.
      // (The home feed is preview-only — real playback lives on
      // player.html so the viewer gets a scrubbable progress bar
      // and automatic episode advancement.)
      const seriesId = item.dataset.seriesId;
      window.location.href =
        "player.html?id=" +
        encodeURIComponent(seriesId) +
        "&ep=" +
        encodeURIComponent(ep);
    });
  }
  function closeEpisodePicker() {
    if (!epSheetEl) return;
    const el = epSheetEl;
    epSheetEl = null;
    el.classList.remove("open");
    setTimeout(() => { try { el.remove(); } catch (_) {} }, 260);
  }

  /* ---------- Search panel ---------- */

  function toggleSearchPanel() {
    if (!searchPanel) return;
    searchPanel.hidden = !searchPanel.hidden;
    if (!searchPanel.hidden) {
      try { searchInput.focus(); } catch (_) {}
      renderSearchResults("");
    }
  }

  function renderSearchResults(term) {
    const list = getSeriesList();
    const q = (term || "").trim().toLowerCase();
    const filtered = !q
      ? list.slice(0, 20)
      : list.filter((v) => {
          const hay = [];
          // Primary localized title / description.
          hay.push(i18n.pickLocalized(v, "title") || "");
          hay.push(i18n.pickLocalized(v, "description") || "");
          // Every other language block (zh / en / …) so cross-language
          // queries match once titles are localized.
          const i18nObj = v.i18n || {};
          Object.keys(i18nObj).forEach((lang) => {
            const blk = i18nObj[lang] || {};
            if (blk.title) hay.push(blk.title);
            if (blk.description) hay.push(blk.description);
          });
          hay.push((Array.isArray(v.tags) ? v.tags : []).join(" "));
          hay.push(v.category || "");
          hay.push(v.author || "");
          return hay.join(" ").toLowerCase().includes(q);
        });

    if (!filtered.length) {
      searchResults.innerHTML =
        `<div class="feed-search-empty">${escapeHtml(t("home.empty"))}</div>`;
      return;
    }

    searchResults.innerHTML = filtered
      .map((s) => {
        const title = i18n.pickLocalized(s, "title");
        const ep = (s.episodes || []).length;
        return `
          <div class="feed-search-row" data-series-id="${escapeAttr(s.id)}">
            <div class="feed-search-thumb">
              <img src="${escapeAttr(s.thumbnail)}" alt="" loading="lazy" />
            </div>
            <div class="feed-search-meta">
              <div class="feed-search-title">${escapeHtml(title)}</div>
              <div class="feed-search-sub">${escapeHtml(
                t("series.epCount", { n: ep })
              )}</div>
            </div>
          </div>
        `;
      })
      .join("");
  }

  function bindSearch() {
    if (searchToggleBtn) {
      searchToggleBtn.addEventListener("click", toggleSearchPanel);
    }
    if (searchInput) {
      let timer;
      searchInput.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(() => renderSearchResults(searchInput.value), 150);
      });
      searchInput.addEventListener("keydown", (e) => {
        if (e.key === "Escape") toggleSearchPanel();
      });
    }
    if (searchBtn) {
      searchBtn.addEventListener("click", () =>
        renderSearchResults(searchInput && searchInput.value)
      );
    }
    if (searchResults) {
      searchResults.addEventListener("click", (e) => {
        const row = e.target.closest(".feed-search-row");
        if (!row) return;
        const id = row.dataset.seriesId;
        toggleSearchPanel();
        scrollFeedToSeries(id);
      });
    }
  }

  function scrollFeedToSeries(seriesId) {
    const target = feedEl.querySelector(
      `.feed-item[data-series-id="${cssEscape(seriesId)}"]`
    );
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ---------- Toast ---------- */
  let toastEl;
  let toastTimer;
  function showToast(msg) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "toast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
  }

  /* ---------- Helpers ---------- */
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function escapeAttr(s) { return escapeHtml(s); }
  function cssEscape(s) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c);
  }

  function refreshAll() {
    renderFeed();
  }

  /* ---------- Init ---------- */
  document.addEventListener("DOMContentLoaded", () => {
    bindSearch();

    // Wait for the library (and best-effort stats + likes) to resolve
    // before the first render — otherwise we'd briefly flash the
    // empty-state overlay because BUILTIN_SERIES is empty and the real
    // catalog lives behind /api/library.
    Promise.all([fetchLibrary(), fetchPlayStats(), fetchLikes()]).then(() =>
      refreshAll()
    );

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        // Pause the active preview when the tab goes to the background
        // so we don't keep streaming video in a hidden tab.
        feedEl.querySelectorAll(".feed-video").forEach((v) => {
          try { v.pause(); } catch (_) {}
        });
      } else {
        // Resume whichever card is currently active.
        const active = feedEl.querySelector(".feed-item.is-active .feed-video");
        if (active) {
          const p = active.play();
          if (p && typeof p.catch === "function") p.catch(() => {});
        }
      }
    });

    if (window.I18N && typeof window.I18N.onChange === "function") {
      window.I18N.onChange(refreshAll);
    }
  });
})();
