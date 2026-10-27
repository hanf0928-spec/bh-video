/* =========================================================
   BH Video — Home page logic
   - Renders the hero, category chips and the SERIES grid.
   - Each card represents a short-drama series (one cover, total
     play-count summed across all of its episodes).
   - Clicking a card opens player.html?id=<seriesId>&ep=1 in a
     NEW TAB/WINDOW (per user requirement). The player page handles
     episode selection from there.
   - "Import" button lets an editor upload an Excel/CSV that adds
     new series + episodes to the catalog (persisted by the backend
     into videos.local.json).
   - All user-facing strings go through window.I18N.
   ========================================================= */

(function () {
  "use strict";

  const Catalog = window.VideoCatalog;
  const heroEl = document.getElementById("hero");
  const categoryBar = document.getElementById("categoryBar");
  const grid = document.getElementById("videoGrid");
  const gridTitle = document.getElementById("gridTitle");
  const emptyState = document.getElementById("emptyState");
  const searchInput = document.getElementById("searchInput");
  const searchBtn = document.getElementById("searchBtn");
  const importBtn = document.getElementById("importBtn");

  // Real play counts fetched from the backend (server.py + views.json).
  // Shape: { "<seriesId>:ep<n>": { opens, plays, ends } }. Empty until
  // /api/stats resolves — the grid renders immediately and is re-rendered
  // as soon as the real numbers arrive.
  let playStats = {};

  const i18n = window.I18N || {
    t: (k) => k,
    pickLocalized: (v, f) => (v ? v[f] : ""),
    localizeCategory: (c) => c,
    onChange: () => () => {},
  };
  const t = (k, p) => i18n.t(k, p);

  /** Get the current series list (rebuilt by mergeImported when imports load). */
  function getSeriesList() {
    return window.VIDEOS || [];
  }

  /**
   * Try to fetch the merged library (built-in + imported) from the backend.
   * If the API is unavailable (e.g. opened via file://) we silently fall
   * back to the built-in list already present in window.VIDEOS.
   */
  function fetchLibrary() {
    return fetch("/api/library", { headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && Array.isArray(data.imported)) {
          Catalog.mergeImported(data.imported);
        }
      })
      .catch(() => {
        /* offline / no backend — keep built-ins */
      });
  }

  /** Fetch real play counts for all known episodes. */
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

  /** Format a play count for display on a card (e.g. 1.2M, 12.3K, 999). */
  function formatCount(n) {
    const num = Number(n) || 0;
    if (num >= 1_000_000)
      return (num / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
    if (num >= 1_000) return (num / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
    return String(num);
  }

  /** Parse a static views label like "1.2M" / "523K" / "999" into a number. */
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

  /**
   * Compute the total play count for a series by summing the real "plays"
   * counters of every episode. If the backend hasn't reported anything for
   * a given episode yet, we fall back to the static `views` label so the
   * card still shows a friendly number.
   */
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

  /** Open the player page in a new tab on the first episode of a series. */
  function openSeries(seriesId) {
    const url = `player.html?id=${encodeURIComponent(seriesId)}&ep=1`;
    window.open(url, "_blank", "noopener");
  }

  // Rotating hero banner state. We keep these at module scope so a
  // rebuild (e.g. after the imported library finishes loading) can
  // cleanly tear down the old timer.
  let heroTimer = null;
  let heroIndex = 0;
  let heroSlides = [];

  function stopHeroCarousel() {
    if (heroTimer) {
      clearInterval(heroTimer);
      heroTimer = null;
    }
  }

  function showHeroSlide(idx) {
    if (!heroSlides.length) return;
    heroIndex = ((idx % heroSlides.length) + heroSlides.length) % heroSlides.length;
    const slideEls = heroEl.querySelectorAll(".hero-slide");
    const dotEls = heroEl.querySelectorAll(".hero-dot");
    slideEls.forEach((el, i) => {
      el.classList.toggle("active", i === heroIndex);
    });
    dotEls.forEach((el, i) => {
      el.classList.toggle("active", i === heroIndex);
    });
  }

  function startHeroCarousel() {
    stopHeroCarousel();
    if (heroSlides.length < 2) return;
    heroTimer = setInterval(() => {
      showHeroSlide(heroIndex + 1);
    }, 5000);
  }

  /**
   * Pick the 3 most recently imported series for the hero carousel.
   * Falls back to catalog order when imported_at is missing (e.g.
   * someone deleted the field by hand or re-serialised the file).
   */
  function pickFeaturedSeries(list) {
    const copy = list.slice();
    copy.sort((a, b) => {
      const ta = Number(a && a.imported_at) || 0;
      const tb = Number(b && b.imported_at) || 0;
      if (tb !== ta) return tb - ta;
      // Stable fallback: keep catalog order so manual testing is
      // predictable even without timestamps.
      return 0;
    });
    return copy.slice(0, 3);
  }

  /** Build the hero / featured banner as a rotating carousel. */
  function renderHero() {
    stopHeroCarousel();
    const list = getSeriesList();
    if (!list.length) {
      heroEl.innerHTML = "";
      heroSlides = [];
      heroEl.classList.remove("hero-has-carousel");
      heroEl.onmouseenter = null;
      heroEl.onmouseleave = null;
      heroEl.onclick = null;
      return;
    }

    heroSlides = pickFeaturedSeries(list);

    const slideHtml = heroSlides
      .map((featured, idx) => {
        const title = i18n.pickLocalized(featured, "title");
        const desc = i18n.pickLocalized(featured, "description");
        const epCount = (featured.episodes || []).length;
        const tags = Array.isArray(featured.tags) ? featured.tags : [];
        return `
          <div class="hero-slide ${idx === 0 ? "active" : ""}" data-series-id="${escapeAttr(
          featured.id
        )}">
            <div class="hero-bg" style="background-image:url('${featured.thumbnail}')"></div>
            <div class="hero-content">
              <span class="hero-badge">${escapeHtml(t("home.featured"))}</span>
              <h1>${escapeHtml(title)}</h1>
              ${
                tags.length
                  ? `<div class="hero-tags">${tags
                      .map(
                        (tag) =>
                          `<span class="tag-chip">${escapeHtml(tag)}</span>`
                      )
                      .join("")}</div>`
                  : ""
              }
              <p>${escapeHtml(desc)}</p>
              <div class="hero-meta">
                <span>${escapeHtml(t("series.epCount", { n: epCount }))}</span>
                <span class="dot">•</span>
                <span>${escapeHtml(
                  formatCount(seriesTotalPlays(featured))
                )} ${escapeHtml(t("card.viewsSuffix"))}</span>
              </div>
              <button class="play-now" type="button">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                  <path d="M8 5v14l11-7z"></path>
                </svg>
                ${escapeHtml(t("home.playNow"))}
              </button>
            </div>
          </div>
        `;
      })
      .join("");

    const dotsHtml =
      heroSlides.length > 1
        ? `<div class="hero-dots">${heroSlides
            .map(
              (_, idx) =>
                `<button type="button" class="hero-dot ${
                  idx === 0 ? "active" : ""
                }" data-dot-idx="${idx}" aria-label="Slide ${idx + 1}"></button>`
            )
            .join("")}</div>`
        : "";

    heroEl.innerHTML = slideHtml + dotsHtml;
    heroEl.classList.toggle("hero-has-carousel", heroSlides.length > 1);
    heroIndex = 0;

    // Click on the hero body → open currently-visible series.
    heroEl.onclick = (e) => {
      if (e.target.closest(".hero-dot")) return; // dots handled separately
      const current = heroSlides[heroIndex];
      if (current) openSeries(current.id);
    };

    // Dot navigation.
    heroEl.querySelectorAll(".hero-dot").forEach((dot) => {
      dot.addEventListener("click", (e) => {
        e.stopPropagation();
        const idx = Number(dot.getAttribute("data-dot-idx")) || 0;
        showHeroSlide(idx);
        // Reset auto-rotate so the user's choice stays visible for a
        // full interval before the next slide takes over.
        startHeroCarousel();
      });
    });

    // Pause on hover so people can read the description.
    heroEl.onmouseenter = stopHeroCarousel;
    heroEl.onmouseleave = startHeroCarousel;

    startHeroCarousel();
  }

  /** Build category chips from the unique set of categories. */
  function renderCategories() {
    const list = getSeriesList();
    const set = new Set(list.map((v) => v.category).filter(Boolean));
    const previouslyActive =
      (categoryBar.querySelector(".chip.active") || {}).dataset?.category ||
      "All";
    const categories = ["All", ...Array.from(set)];

    categoryBar.innerHTML = categories
      .map(
        (c) =>
          `<button class="chip ${c === previouslyActive ? "active" : ""}" data-category="${escapeAttr(
            c
          )}">${escapeHtml(i18n.localizeCategory(c))}</button>`
      )
      .join("");
  }

  function bindCategoryEvents() {
    categoryBar.addEventListener("click", (e) => {
      const btn = e.target.closest(".chip");
      if (!btn) return;
      [...categoryBar.querySelectorAll(".chip")].forEach((c) =>
        c.classList.remove("active")
      );
      btn.classList.add("active");
      applyFilters();
    });
  }

  /** Render the grid of series cards based on the supplied list. */
  function renderGrid(list) {
    if (!list.length) {
      grid.innerHTML = "";
      emptyState.hidden = false;
      return;
    }
    emptyState.hidden = true;

    grid.innerHTML = list
      .map((s) => {
        const title = i18n.pickLocalized(s, "title");
        const totalViews = formatCount(seriesTotalPlays(s));
        const epCount = (s.episodes || []).length;
        const tags = Array.isArray(s.tags) ? s.tags.slice(0, 3) : [];
        return `
        <article class="video-card" data-id="${escapeAttr(s.id)}" tabindex="0" role="button"
                 aria-label="${escapeAttr(t("card.openAria", { title }))}">
          <div class="thumb">
            <img src="${escapeAttr(s.thumbnail)}" alt="${escapeAttr(title)}"
                 loading="lazy"
                 onerror="this.style.background='linear-gradient(135deg,#2a2a36,#16161c)';this.removeAttribute('src');" />
            <span class="duration">${escapeHtml(
              t("series.epBadge", { n: epCount })
            )}</span>
            <div class="play-overlay"></div>
          </div>
          <div class="card-body">
            <h3 class="card-title">${escapeHtml(title)}</h3>
            ${
              tags.length
                ? `<div class="card-tags">${tags
                    .map(
                      (tag) =>
                        `<span class="tag-chip tag-chip--sm">${escapeHtml(
                          tag
                        )}</span>`
                    )
                    .join("")}</div>`
                : ""
            }
            <div class="card-meta">${escapeHtml(
              t("series.epCount", { n: epCount })
            )} • ${escapeHtml(totalViews)} ${escapeHtml(
          t("card.viewsSuffix")
        )}</div>
          </div>
        </article>
      `;
      })
      .join("");
  }

  /** Apply both the category filter and the search filter. */
  function applyFilters() {
    const list = getSeriesList();
    const activeChip = categoryBar.querySelector(".chip.active");
    const category = activeChip ? activeChip.dataset.category : "All";
    const term = (searchInput.value || "").trim().toLowerCase();

    let filtered = list.slice();
    if (category && category !== "All") {
      filtered = filtered.filter((v) => v.category === category);
    }
    if (term) {
      filtered = filtered.filter((v) => {
        const title = i18n.pickLocalized(v, "title") || "";
        const desc = i18n.pickLocalized(v, "description") || "";
        const tagsText = (Array.isArray(v.tags) ? v.tags : []).join(" ");
        return (
          title.toLowerCase().includes(term) ||
          desc.toLowerCase().includes(term) ||
          tagsText.toLowerCase().includes(term) ||
          (v.category || "").toLowerCase().includes(term) ||
          i18n.localizeCategory(v.category || "").toLowerCase().includes(term)
        );
      });
    }

    if (term && category === "All") {
      gridTitle.textContent = t("home.results", { term });
    } else if (category === "All") {
      gridTitle.textContent = t("home.allVideos");
    } else {
      gridTitle.textContent = i18n.localizeCategory(category);
    }

    renderGrid(filtered);
  }

  /** Click delegation for the grid → open player in a new tab. */
  function bindGridEvents() {
    grid.addEventListener("click", (e) => {
      const card = e.target.closest(".video-card");
      if (!card) return;
      openSeries(card.dataset.id);
    });

    grid.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const card = e.target.closest(".video-card");
      if (!card) return;
      e.preventDefault();
      openSeries(card.dataset.id);
    });
  }

  function bindSearch() {
    let timer;
    searchInput.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(applyFilters, 150);
    });
    searchBtn.addEventListener("click", applyFilters);
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") applyFilters();
    });
  }

  /* =====================================================================
     Excel import flow
     ---------------------------------------------------------------------
     1. User clicks "Import" → modal opens.
     2. User picks an .xlsx / .xls / .csv file.
     3. SheetJS (loaded from CDN on demand) parses the workbook on the
        client. We accept either:
          (a) a single sheet whose columns include both series and episode
              fields (one row per episode);
          (b) two sheets named "series" and "episodes" linked by series_id.
     4. Parsed series are POSTed to /api/import where the backend persists
        them into videos.local.json. The client then reloads the library.
     ===================================================================== */

  const SHEETJS_URL =
    "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
  let sheetJsLoading = null;

  function loadSheetJs() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (sheetJsLoading) return sheetJsLoading;
    sheetJsLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = SHEETJS_URL;
      s.async = true;
      s.onload = () => resolve(window.XLSX);
      s.onerror = () => reject(new Error("Failed to load xlsx parser"));
      document.head.appendChild(s);
    });
    return sheetJsLoading;
  }

  /** Lower-case + trim a header so we can match user typos like "Series_ID ". */
  function normHeader(h) {
    return String(h || "").trim().toLowerCase().replace(/\s+/g, "_");
  }

  /** Read a row by any of the accepted header aliases. */
  function pick(row, ...aliases) {
    for (const a of aliases) {
      const key = normHeader(a);
      if (row[key] !== undefined && row[key] !== null && row[key] !== "")
        return row[key];
    }
    return "";
  }

  /** Split a tag string like "都市,言情; 甜宠" into a clean array. */
  function parseTags(value) {
    if (value == null) return [];
    if (Array.isArray(value)) {
      return value
        .map((t) => String(t || "").trim())
        .filter((t) => t.length > 0);
    }
    return String(value)
      .split(/[,;\u3001\uFF0C\uFF1B|\/]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }

  /** Convert raw sheet rows (with normalised keys) into Series objects. */
  function rowsToSeries(rows) {
    const byId = new Map();
    rows.forEach((row) => {
      const seriesId = String(pick(row, "series_id", "id", "seriesid")).trim();
      if (!seriesId) return;
      const tagsValue = pick(row, "tags", "tag", "category", "genre");
      const tagList = parseTags(tagsValue);
      let s = byId.get(seriesId);
      if (!s) {
        s = {
          id: seriesId,
          title: String(
            pick(row, "series_title", "title", "name") || seriesId
          ).trim(),
          // category drives the home-page filter chips. We use the first
          // tag as the canonical category so the chips stay focused.
          category: tagList[0] || "短剧",
          tags: tagList.slice(),
          description: String(pick(row, "description", "desc") || "").trim(),
          thumbnail: String(pick(row, "thumbnail", "cover", "poster") || "")
            .trim(),
          episodes: [],
        };
        byId.set(seriesId, s);
      } else {
        // Allow later rows to fill in series-level metadata if the first
        // row left it blank.
        const tit = String(
          pick(row, "series_title", "title", "name") || ""
        ).trim();
        if (tit && (!s.title || s.title === seriesId)) s.title = tit;
        const desc = String(pick(row, "description", "desc") || "").trim();
        if (desc && !s.description) s.description = desc;
        const thumb = String(
          pick(row, "thumbnail", "cover", "poster") || ""
        ).trim();
        if (thumb && !s.thumbnail) s.thumbnail = thumb;
        if (tagList.length && (!s.tags || !s.tags.length)) {
          s.tags = tagList.slice();
          s.category = tagList[0] || s.category;
        }
      }

      const src = String(pick(row, "src", "url", "video_url") || "").trim();
      if (!src) return; // skip rows with no episode payload
      const epNum = Number(pick(row, "ep", "episode", "ep_no") || 0);
      const finalEpNum = epNum > 0 ? epNum : s.episodes.length + 1;
      const ep = {
        ep: finalEpNum,
        // Episode title falls back to "第N集" so the sidebar always shows
        // a friendly label even if the user didn't provide one.
        title: String(
          pick(row, "ep_title", "episode_title") || `第${finalEpNum}集`
        ).trim(),
        src,
        duration: String(pick(row, "duration", "length") || "").trim(),
        thumbnail: String(
          pick(row, "ep_thumbnail", "episode_thumbnail") || s.thumbnail || ""
        ).trim(),
        views: String(pick(row, "views") || "").trim(),
      };
      s.episodes.push(ep);
    });

    // Sort each series' episodes by ep number for deterministic order.
    const out = Array.from(byId.values());
    out.forEach((s) => s.episodes.sort((a, b) => a.ep - b.ep));
    return out.filter((s) => s.episodes.length > 0);
  }

  /** Parse an ArrayBuffer (xlsx/xls/csv) → Series[]. */
  function parseWorkbook(buffer) {
    const XLSX = window.XLSX;
    const wb = XLSX.read(buffer, { type: "array" });
    const sheetNames = wb.SheetNames || [];

    // Two-sheet layout (series + episodes).
    const seriesSheet = sheetNames.find((n) => /^series$/i.test(n));
    const episodesSheet = sheetNames.find((n) => /^episodes?$/i.test(n));
    if (seriesSheet && episodesSheet) {
      const seriesRows = XLSX.utils
        .sheet_to_json(wb.Sheets[seriesSheet], { defval: "" })
        .map(normaliseRow);
      const episodeRows = XLSX.utils
        .sheet_to_json(wb.Sheets[episodesSheet], { defval: "" })
        .map(normaliseRow);

      const byId = new Map();
      seriesRows.forEach((r) => {
        const id = String(pick(r, "series_id", "id") || "").trim();
        if (!id) return;
        const tagsValue = pick(r, "tags", "tag", "category", "genre");
        const tagList = parseTags(tagsValue);
        byId.set(id, {
          id,
          title: String(pick(r, "title", "name", "series_title") || id).trim(),
          category: tagList[0] || "短剧",
          tags: tagList.slice(),
          description: String(pick(r, "description", "desc") || "").trim(),
          thumbnail: String(pick(r, "thumbnail", "cover", "poster") || "")
            .trim(),
          episodes: [],
        });
      });
      episodeRows.forEach((r) => {
        const id = String(pick(r, "series_id", "id") || "").trim();
        const src = String(pick(r, "src", "url", "video_url") || "").trim();
        if (!id || !src) return;
        const s = byId.get(id);
        if (!s) return;
        const epNum = Number(pick(r, "ep", "episode", "ep_no") || 0);
        const finalEpNum = epNum > 0 ? epNum : s.episodes.length + 1;
        s.episodes.push({
          ep: finalEpNum,
          title: String(
            pick(r, "ep_title", "episode_title", "title") || `第${finalEpNum}集`
          ).trim(),
          src,
          duration: String(pick(r, "duration", "length") || "").trim(),
          thumbnail: String(
            pick(r, "ep_thumbnail", "episode_thumbnail", "thumbnail") ||
              s.thumbnail ||
              ""
          ).trim(),
          views: String(pick(r, "views") || "").trim(),
        });
      });
      const out = Array.from(byId.values());
      out.forEach((s) => s.episodes.sort((a, b) => a.ep - b.ep));
      return out.filter((s) => s.episodes.length > 0);
    }

    // Single-sheet fallback: take the first sheet.
    const first = wb.Sheets[sheetNames[0]];
    if (!first) return [];
    const rows = XLSX.utils
      .sheet_to_json(first, { defval: "" })
      .map(normaliseRow);
    return rowsToSeries(rows);
  }

  function normaliseRow(row) {
    const out = {};
    Object.keys(row).forEach((k) => {
      out[normHeader(k)] = row[k];
    });
    return out;
  }

  /* ---------- Modal UI ---------- */

  let modalEl;
  function ensureModal() {
    if (modalEl) return modalEl;
    modalEl = document.createElement("div");
    modalEl.className = "modal-backdrop";
    modalEl.hidden = true;
    modalEl.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="importTitle">
        <header class="modal-header">
          <h2 id="importTitle">${escapeHtml(t("import.title"))}</h2>
          <button class="modal-close" type="button" aria-label="${escapeAttr(
            t("import.close")
          )}">×</button>
        </header>
        <div class="modal-body">
          <p class="modal-desc">${escapeHtml(t("import.desc"))}</p>
          <ul class="modal-hints">
            <li>${escapeHtml(t("import.hint.cols"))}</li>
            <li>${escapeHtml(t("import.hint.multi"))}</li>
            <li>${escapeHtml(t("import.hint.format"))}</li>
          </ul>
          <div class="file-drop" tabindex="0">
            <input type="file" id="importFile" accept=".xlsx,.xls,.csv" hidden />
            <div class="file-drop-inner">
              <div class="file-drop-icon">📥</div>
              <div class="file-drop-text">${escapeHtml(t("import.drop"))}</div>
              <button type="button" class="file-pick-btn">${escapeHtml(
                t("import.choose")
              )}</button>
            </div>
          </div>
          <div class="import-preview" hidden></div>
          <div class="import-status" aria-live="polite"></div>
        </div>
        <footer class="modal-footer">
          <button type="button" class="btn-secondary" data-action="cancel">${escapeHtml(
            t("import.cancel")
          )}</button>
          <button type="button" class="btn-primary" data-action="confirm" disabled>${escapeHtml(
            t("import.confirm")
          )}</button>
        </footer>
      </div>
    `;
    document.body.appendChild(modalEl);

    let parsedSeries = [];
    const fileInput = modalEl.querySelector("#importFile");
    const pickBtn = modalEl.querySelector(".file-pick-btn");
    const drop = modalEl.querySelector(".file-drop");
    const preview = modalEl.querySelector(".import-preview");
    const status = modalEl.querySelector(".import-status");
    const confirmBtn = modalEl.querySelector('[data-action="confirm"]');

    function close() {
      modalEl.hidden = true;
      parsedSeries = [];
      preview.hidden = true;
      preview.innerHTML = "";
      status.textContent = "";
      confirmBtn.disabled = true;
      fileInput.value = "";
    }
    modalEl.addEventListener("click", (e) => {
      if (e.target === modalEl) close();
      if (e.target.closest(".modal-close")) close();
      if (e.target.closest('[data-action="cancel"]')) close();
    });
    modalEl.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    });

    pickBtn.addEventListener("click", () => fileInput.click());
    drop.addEventListener("click", (e) => {
      if (!e.target.closest(".file-pick-btn")) fileInput.click();
    });
    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("drag");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("drag");
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) handleFile(file);
    });
    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      if (file) handleFile(file);
    });

    function handleFile(file) {
      status.textContent = t("import.status.parsing");
      preview.hidden = true;
      preview.innerHTML = "";
      confirmBtn.disabled = true;
      parsedSeries = [];

      loadSheetJs()
        .then(() => file.arrayBuffer())
        .then((buf) => {
          const series = parseWorkbook(buf);
          if (!series.length) {
            status.textContent = t("import.status.empty");
            return;
          }
          parsedSeries = series;
          renderPreview(series);
          status.textContent = t("import.status.parsed", {
            n: series.length,
            e: series.reduce((acc, s) => acc + s.episodes.length, 0),
          });
          confirmBtn.disabled = false;
        })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.error("[import] parse failed", err);
          status.textContent = t("import.status.error", {
            msg: (err && err.message) || "parse error",
          });
        });
    }

    function renderPreview(series) {
      preview.hidden = false;
      preview.innerHTML = `
        <h3 class="preview-title">${escapeHtml(t("import.preview"))}</h3>
        <ul class="preview-list">
          ${series
            .map(
              (s) => `
            <li>
              <strong>${escapeHtml(s.title)}</strong>
              <span class="muted">(${escapeHtml(s.id)})</span>
              — ${escapeHtml(t("series.epCount", { n: s.episodes.length }))}
            </li>`
            )
            .join("")}
        </ul>
      `;
    }

    confirmBtn.addEventListener("click", () => {
      if (!parsedSeries.length) return;
      confirmBtn.disabled = true;
      status.textContent = t("import.status.uploading");
      fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ series: parsedSeries }),
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(r)))
        .then((data) => {
          if (data && data.ok) {
            status.textContent = t("import.status.done", {
              n: data.added || parsedSeries.length,
            });
            // Reload library + stats and re-render.
            return Promise.all([fetchLibrary(), fetchPlayStats()]).then(() => {
              refreshAll();
              setTimeout(close, 800);
            });
          }
          throw new Error("server rejected");
        })
        .catch(() => {
          status.textContent = t("import.status.uploadFailed");
          confirmBtn.disabled = false;
        });
    });

    return modalEl;
  }

  function openImportModal() {
    const m = ensureModal();
    // Refresh strings (in case language changed since last open).
    m.querySelector("#importTitle").textContent = t("import.title");
    m.querySelector(".modal-desc").textContent = t("import.desc");
    const hints = m.querySelectorAll(".modal-hints li");
    if (hints.length >= 3) {
      hints[0].textContent = t("import.hint.cols");
      hints[1].textContent = t("import.hint.multi");
      hints[2].textContent = t("import.hint.format");
    }
    m.querySelector(".file-drop-text").textContent = t("import.drop");
    m.querySelector(".file-pick-btn").textContent = t("import.choose");
    m.querySelector('[data-action="cancel"]').textContent = t("import.cancel");
    m.querySelector('[data-action="confirm"]').textContent = t(
      "import.confirm"
    );
    m.querySelector(".modal-close").setAttribute(
      "aria-label",
      t("import.close")
    );
    m.hidden = false;
  }

  function bindImport() {
    if (!importBtn) return;
    importBtn.addEventListener("click", openImportModal);
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
  function escapeAttr(s) {
    return escapeHtml(s);
  }

  /** Re-render every dynamic block when the language or library changes. */
  function refreshAll() {
    renderHero();
    renderCategories();
    applyFilters();
  }

  /* ---------- Init ---------- */
  document.addEventListener("DOMContentLoaded", () => {
    renderHero();
    renderCategories();
    bindCategoryEvents();
    renderGrid(getSeriesList());
    bindGridEvents();
    bindSearch();
    bindImport();

    // Pull imported library + real play counts in parallel, then re-render.
    Promise.all([fetchLibrary(), fetchPlayStats()]).then(() => refreshAll());

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        fetchPlayStats().then(() => applyFilters());
      }
    });

    if (window.I18N && typeof window.I18N.onChange === "function") {
      window.I18N.onChange(refreshAll);
    }
  });
})();
