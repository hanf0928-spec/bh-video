// Video catalog data — short-drama series model.
//
// A "series" is a show users browse on the home page. Each series owns a
// list of "episodes". The home grid renders one card per series, the
// player page plays one episode at a time and shows the series' episode
// list in the sidebar.
//
// Shape (TypeScript-ish) :
//
//   interface Series {
//     id:          string;          // unique series id
//     title:       string;          // series title shown on the home grid
//     description: string;          // long-form description / synopsis
//     tags:        string[];        // free-form labels, e.g. ["都市","言情"]
//     category:    string;          // chip filter on the home page
//                                   //   (usually = tags[0])
//     thumbnail:   string;          // cover image (also used as fallback
//                                   //   poster for episodes that don't
//                                   //   ship their own thumbnail)
//     i18n?:       { [lang]: { title?, description? } };
//     episodes:    Episode[];
//   }
//   interface Episode {
//     ep:        number;            // 1-based episode number
//     title:     string;            // optional, falls back to "第N集"
//     src:       string;            // video URL
//     duration?: string;            // "mm:ss" — optional
//     thumbnail?:string;            // optional per-episode poster
//     views?:    string;            // static fallback views label
//   }
//
// Each episode is identified across the app by the composite id
// "<seriesId>:ep<n>" (see episodeKey() below). That composite id is what
// the play-stats backend stores under, so per-episode counters stay
// independent while the series total is just the sum of its episodes.

(function () {
  "use strict";

  // BUILTIN_SERIES 以前存放了 3 部演示短剧（兔兔传奇 / 辛特尔传说 / 示例短片合集），
  // 已按产品要求删除。所有真正展示在首页的作品都来自 /api/library（即
  // videos.local.json，由管理后台 → 作品管理 批量上传或 COS 导入），
  // 由 mergeImported() 在页面加载时注入到 window.VIDEOS。
  // 如果以后需要内置样例，直接在这个数组里补一两条即可。
  const BUILTIN_SERIES = [];

  /** Composite id used by /api/stats for a single episode. */
  function episodeKey(seriesId, ep) {
    return `${seriesId}:ep${ep}`;
  }

  /** Find a series by id. */
  function findSeries(seriesId) {
    return (window.VIDEOS || []).find((s) => s.id === seriesId) || null;
  }

  /** Find an episode inside a series. Falls back to the first episode. */
  function findEpisode(series, ep) {
    if (!series || !Array.isArray(series.episodes) || !series.episodes.length)
      return null;
    const num = Number(ep);
    return (
      series.episodes.find((e) => Number(e.ep) === num) || series.episodes[0]
    );
  }

  /**
   * Merge user-imported series (from /api/library) into the catalog. Imported
   * series with the same id override the built-in entry so authors can fix
   * typos by re-uploading the same Excel.
   */
  function mergeImported(imported) {
    // ACCUMULATING merge: keep whatever is already in window.VIDEOS and
    // overlay the incoming batch on top (keyed by id). This matters
    // because the home feed first loads the full catalog (all series)
    // and then lazily hydrates ONE series at a time via
    // /api/library/<id> (player.js on the player page, and app.js's
    // hydrateSeriesSrc when a feed card becomes active). If we rebuilt
    // the Map from scratch each call, that single-series hydration would
    // DROP every other series — and then search (which reads
    // window.VIDEOS) could only ever find the one currently playing.
    const byId = new Map();
    (window.VIDEOS || []).forEach((s) => {
      if (s && s.id) byId.set(s.id, s);
    });
    (imported || []).forEach((s) => {
      if (s && s.id) byId.set(s.id, s);
    });
    window.VIDEOS = Array.from(byId.values());
  }

  // Initial export — built-ins only. app.js / player.js will call
  // VideoCatalog.mergeImported() once /api/library resolves.
  window.VIDEOS = BUILTIN_SERIES.slice();
  window.VideoCatalog = {
    episodeKey,
    findSeries,
    findEpisode,
    mergeImported,
    BUILTIN_SERIES,
  };
})();
