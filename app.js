/* =========================================================
   BH Video — Home page (immersive vertical feed, "红果" style)
   -----------------------------------------------------------
   Behaviour summary:
   - The home page is a full-screen vertical feed. Each snap
     "card" occupies 100vw × 100vh and represents ONE series.
   - Users swipe up/down to move between series (CSS scroll-snap
     + IntersectionObserver).
   - The card currently in view auto-plays episode 1. When an
     episode ends we automatically advance to the next episode
     of the SAME series. When the last episode of a series
     finishes we stay on that card (user can swipe to the next
     series or re-watch).
   - Only the visible card has an active <video> element to
     keep memory + bandwidth in check (we lazily hydrate the
     neighbouring card's poster image).
   - A top-right floating button acts as "back to home" — it
     scrolls the feed back to the very first series.
   - Clicking the on-video title/CTA opens player.html for
     the dedicated player page (sharing / deep-links).
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
    return fetch("/api/library", { headers: { Accept: "application/json" } })
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
   * Build a single feed item: a 100vw × 100vh card containing a
   * <video> element plus overlays (title, episode indicator,
   * right-side actions, bottom CTA).
   */
  function buildFeedItem(series, index) {
    const title = i18n.pickLocalized(series, "title");
    const desc = i18n.pickLocalized(series, "description");
    const tags = Array.isArray(series.tags) ? series.tags.slice(0, 3) : [];
    const epCount = (series.episodes || []).length;
    const totalPlays = formatCount(seriesTotalPlays(series));
    const firstEp = (series.episodes || [])[0];
    const poster = (firstEp && firstEp.thumbnail) || series.thumbnail || "";

    const item = document.createElement("section");
    item.className = "feed-item";
    item.dataset.seriesId = series.id;
    item.dataset.index = String(index);

    item.innerHTML = `
      <video class="feed-video"
             playsinline webkit-playsinline
             preload="none"
             poster="${escapeAttr(poster)}"
             data-series-id="${escapeAttr(series.id)}"></video>

      <!-- Dark gradient so overlays stay readable on any poster -->
      <div class="feed-gradient"></div>

      <!-- Play / pause big center icon (only shown while paused) -->
      <button class="feed-playpause" type="button" aria-label="播放/暂停">
        <svg class="icon-play" viewBox="0 0 24 24" width="56" height="56" fill="#fff">
          <path d="M8 5v14l11-7z"></path>
        </svg>
      </button>

      <!-- Right-side action rail (like / share) -->
      <div class="feed-side">
        <button class="feed-side-btn feed-like" type="button" aria-label="点赞">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none"
               stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
          </svg>
          <span class="feed-side-label">${escapeHtml(formatCount(totalPlays))}</span>
        </button>

        <button class="feed-side-btn feed-share" type="button" aria-label="分享">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none"
               stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round">
            <circle cx="18" cy="5" r="3"></circle>
            <circle cx="6" cy="12" r="3"></circle>
            <circle cx="18" cy="19" r="3"></circle>
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
          </svg>
          <span class="feed-side-label" data-i18n="player.share">分享</span>
        </button>

        <button class="feed-side-btn feed-ep-picker" type="button" aria-label="选集">
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
   * Load a specific episode into the <video> element of a feed item.
   * Updates the "第X集" chip, resets progress bar, triggers pre-roll
   * ad gate, and auto-plays.
   */
  function loadEpisodeInto(item, series, epNum, opts) {
    opts = opts || {};
    const video = item.querySelector(".feed-video");
    if (!video || !series) return;
    const episode = episodeByNum(series, epNum);
    if (!episode) return;

    const chip = item.querySelector("[data-ep-chip]");
    if (chip) chip.textContent = t("series.epShort", { n: episode.ep });

    const progress = item.querySelector("[data-progress]");
    if (progress) progress.style.width = "0%";

    video.src = episode.src;
    video.poster = episode.thumbnail || series.thumbnail || "";
    video.dataset.epNum = String(episode.ep);
    video.load();

    const state = getItemState(series.id);
    state.currentEp = episode.ep;

    reportStat(series.id, episode.ep, "open");

    // Pre-roll ad gate (same rule as player page).
    const Ads = window.BHAds;
    const shouldPreRoll =
      opts.skipPreRoll
        ? false
        : Ads && typeof Ads.notifyEpisodeOpen === "function"
        ? Ads.notifyEpisodeOpen(series.id, episode.ep)
        : false;

    const startPlay = () => {
      // Only play if this item is still the active one.
      if (!item.classList.contains("is-active")) return;
      const p = video.play();
      if (p && typeof p.catch === "function") {
        p.catch(() => {
          /* autoplay blocked — user can tap center icon */
          item.classList.add("is-paused");
        });
      }
    };

    if (shouldPreRoll && Ads && typeof Ads.playPreRoll === "function") {
      try { video.pause(); } catch (_) {}
      Ads.playPreRoll().finally(() => {
        if (
          video.dataset.epNum === String(episode.ep) &&
          video.dataset.seriesId === series.id
        ) {
          startPlay();
        }
      });
    } else {
      startPlay();
    }
  }

  /**
   * Jump from the home feed to the full player page.
   * Carries three pieces of state in the URL so playback can continue
   * seamlessly:
   *   id = series id
   *   ep = episode number
   *   t  = current playback time (seconds) within that episode
   * When `t >= duration - 0.5` (meaning the preview already finished),
   * we instead redirect to the NEXT episode starting at t=0, so the
   * player page naturally resumes with the following episode of the
   * same series.
   */
  function openPlayerForItem(item) {
    const seriesId = item.dataset.seriesId;
    const series = Catalog.findSeries(seriesId);
    if (!series) return;
    const video = item.querySelector(".feed-video");
    if (!video) return;

    const curEp = Number(video.dataset.epNum) || 1;
    const currentTime = Number(video.currentTime) || 0;
    const duration = Number(video.duration) || 0;

    let targetEp = curEp;
    let targetTime = currentTime;

    // If the current preview episode has already finished, roll over
    // to the next episode (if any) so the player page picks up where
    // the feed left off.
    const finished = duration > 0 && currentTime >= duration - 0.5;
    if (finished) {
      const idx = (series.episodes || []).findIndex(
        (e) => Number(e.ep) === curEp
      );
      const next = idx >= 0 ? series.episodes[idx + 1] : null;
      if (next) {
        targetEp = next.ep;
        targetTime = 0;
      } else {
        // Last episode of the series — restart from the beginning of
        // the current episode on the player page.
        targetTime = 0;
      }
    }

    // Pause the preview before navigating so the audio doesn't double
    // up if the browser caches the home page.
    try { video.pause(); } catch (_) {}

    const url =
      "player.html?id=" + encodeURIComponent(series.id) +
      "&ep=" + encodeURIComponent(targetEp) +
      "&t=" + encodeURIComponent(Math.max(0, Math.floor(targetTime)));
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
    const shareBtn = item.querySelector(".feed-share");
    const epPicker = item.querySelector(".feed-ep-picker");
    const progress = item.querySelector("[data-progress]");

    // Tap on the video area → jump to the full player page.
    // The home feed is a preview only; actual playback (with a
    // scrubbable progress bar, like/share, episode auto-advance,
    // etc.) happens on player.html.
    video.addEventListener("click", () => openPlayerForItem(item));
    playBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openPlayerForItem(item);
    });

    // When the preview episode ends → jump to the player page so the
    // viewer continues watching. If it was the FIRST episode of a
    // series the player page will naturally take over at episode 2
    // (handled by openPlayerForItem's roll-over logic).
    video.addEventListener("ended", () => {
      reportStat(series.id, Number(video.dataset.epNum) || 1, "ended");
      openPlayerForItem(item);
    });

    // Report "play" at most once per episode.
    let lastPlayReportedEp = null;
    video.addEventListener("play", () => {
      item.classList.remove("is-paused");
      const ep = Number(video.dataset.epNum) || 1;
      const key = series.id + ":" + ep;
      if (lastPlayReportedEp !== key) {
        lastPlayReportedEp = key;
        reportStat(series.id, ep, "play");
      }
    });
    video.addEventListener("pause", () => {
      if (!video.ended) item.classList.add("is-paused");
    });

    // Progress bar sync.
    video.addEventListener("timeupdate", () => {
      if (!progress || !video.duration) return;
      const pct = (video.currentTime / video.duration) * 100;
      progress.style.width = pct + "%";
    });

    // Like / share / episode picker.
    likeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      likeBtn.classList.toggle("liked");
    });
    shareBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const url =
        location.origin +
        "/player.html?id=" + encodeURIComponent(series.id) + "&ep=" +
        (Number(video.dataset.epNum) || 1);
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
    const series = Catalog.findSeries(seriesId);
    if (!series) return;
    const state = getItemState(seriesId);
    const video = item.querySelector(".feed-video");
    // First time activating → load the right episode.
    if (!state.hasStarted) {
      state.hasStarted = true;
      loadEpisodeInto(item, series, state.currentEp || 1);
    } else {
      // Re-entering a card: just resume whatever was playing.
      const p = video.play();
      if (p && typeof p.catch === "function") {
        p.catch(() => item.classList.add("is-paused"));
      }
    }
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
          <button class="feed-ep-sheet-close" type="button" aria-label="关闭">×</button>
        </div>
        <div class="feed-ep-sheet-grid">
          ${(series.episodes || [])
            .map((e) => {
              const isActive =
                Number(e.ep) === Number(
                  item.querySelector(".feed-video").dataset.epNum || 1
                );
              return `<button class="feed-ep-cell ${
                isActive ? "active" : ""
              }" data-ep="${escapeAttr(String(e.ep))}">${escapeHtml(
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
      loadEpisodeInto(item, series, ep, { skipPreRoll: false });
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
          const title = i18n.pickLocalized(v, "title") || "";
          const desc = i18n.pickLocalized(v, "description") || "";
          const tagsText = (Array.isArray(v.tags) ? v.tags : []).join(" ");
          return (
            title.toLowerCase().includes(q) ||
            desc.toLowerCase().includes(q) ||
            tagsText.toLowerCase().includes(q)
          );
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

    // Wait for the library (and best-effort stats) to resolve before
    // the first render — otherwise we'd briefly flash the empty-state
    // overlay because BUILTIN_SERIES is empty and the real catalog
    // lives behind /api/library.
    Promise.all([fetchLibrary(), fetchPlayStats()]).then(() => refreshAll());

    document.addEventListener("visibilitychange", () => {
      // Pause everything when the tab is hidden.
      if (document.visibilityState === "hidden") {
        feedEl.querySelectorAll(".feed-video").forEach((v) => {
          try { v.pause(); } catch (_) {}
        });
      } else {
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
