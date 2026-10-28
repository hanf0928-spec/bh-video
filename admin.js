/* =========================================================
   BH Video — Admin dashboard logic
   - Password-gated login (POST /api/admin/login).
   - Fetches /api/admin/overview and renders:
       • KPIs (today UV, total plays, ad clicks)
       • Daily UV bar chart (30 days)
       • Ads table (impressions / clicks / CTR per slot)
       • Videos table (plays per episode, join with videos.js
         so we can show human-readable series + ep titles)
   - Token stored in sessionStorage so a page refresh keeps the
     session without surviving tab/browser restart.
   ========================================================= */

(function () {
  "use strict";

  const TOKEN_KEY = "bhv.adminToken";

  const AD_SLOT_LABELS = {
    top: "首部广告栏 (Top Banner)",
    bottom: "尾部广告栏 (Bottom Banner)",
    float: "悬浮广告 (Floating Box)",
    preroll: "插播广告视频 (Pre-roll)",
    preroll_cta: "插播广告按钮 (CTA)",
  };

  const loginScreen = document.getElementById("loginScreen");
  const loginForm = document.getElementById("loginForm");
  const loginPassword = document.getElementById("loginPassword");
  const loginError = document.getElementById("loginError");
  const dashboard = document.getElementById("dashboard");
  const refreshBtn = document.getElementById("refreshBtn");
  const logoutBtn = document.getElementById("logoutBtn");
  const generatedAt = document.getElementById("generatedAt");

  const kpiUvToday = document.getElementById("kpiUvToday");
  const kpiUv30 = document.getElementById("kpiUv30");
  const kpiPlays = document.getElementById("kpiPlays");
  const kpiOpens = document.getElementById("kpiOpens");
  const kpiEnds = document.getElementById("kpiEnds");
  const kpiAdClicks = document.getElementById("kpiAdClicks");
  const kpiAdImpr = document.getElementById("kpiAdImpr");
  const kpiAdCtr = document.getElementById("kpiAdCtr");

  const uvChart = document.getElementById("uvChart");
  const adsTbody = document.getElementById("adsTbody");
  const videosTbody = document.getElementById("videosTbody");

  // ---- Library / upload tab elements ----
  const tabs = document.querySelectorAll(".admin-tab");
  const tabOverview = document.getElementById("tab-overview");
  const tabLibrary = document.getElementById("tab-library");

  const uploadModeBtns = document.querySelectorAll(".upload-mode-btn");
  const uploadFormPane = document.getElementById("uploadForm");
  const uploadJsonPane = document.getElementById("uploadJson");
  const uploadFilePane = document.getElementById("uploadFile");

  const seriesForms = document.getElementById("seriesForms");
  const addSeriesBtn = document.getElementById("addSeriesBtn");
  const submitSeriesBtn = document.getElementById("submitSeriesBtn");
  const uploadStatus = document.getElementById("uploadStatus");

  const jsonInput = document.getElementById("jsonInput");
  const submitJsonBtn = document.getElementById("submitJsonBtn");
  const jsonStatus = document.getElementById("jsonStatus");

  const fileInput = document.getElementById("fileInput");
  const fileDrop = document.getElementById("fileDrop");
  const filePreview = document.getElementById("filePreview");
  const replaceMode = document.getElementById("replaceMode");
  const submitFileBtn = document.getElementById("submitFileBtn");
  const fileStatus = document.getElementById("fileStatus");

  const libraryTbody = document.getElementById("libraryTbody");
  const reloadLibraryBtn = document.getElementById("reloadLibraryBtn");

  const seriesFormTpl = document.getElementById("seriesFormTpl");
  const episodeRowTpl = document.getElementById("episodeRowTpl");

  // ---- COS import panel ----
  const uploadCosPane = document.getElementById("uploadCos");
  const cosPrefix = document.getElementById("cosPrefix");
  const cosTitle = document.getElementById("cosTitle");
  const cosId = document.getElementById("cosId");
  const cosCategory = document.getElementById("cosCategory");
  const cosAuthor = document.getElementById("cosAuthor");
  const cosDescription = document.getElementById("cosDescription");
  const cosPreviewBtn = document.getElementById("cosPreviewBtn");
  const cosImportBtn = document.getElementById("cosImportBtn");
  const cosStatus = document.getElementById("cosStatus");
  const cosPreview = document.getElementById("cosPreview");

  // ---- COS batch (parent folder) sub-panel ----
  const cosSubBtns = document.querySelectorAll(".upload-cos-sub-btn");
  const uploadCosSingle = document.getElementById("uploadCosSingle");
  const uploadCosBatch = document.getElementById("uploadCosBatch");
  const cosBatchPrefix = document.getElementById("cosBatchPrefix");
  const cosBatchCategory = document.getElementById("cosBatchCategory");
  const cosBatchAuthor = document.getElementById("cosBatchAuthor");
  const cosBatchPreviewBtn = document.getElementById("cosBatchPreviewBtn");
  const cosBatchImportBtn = document.getElementById("cosBatchImportBtn");
  const cosBatchStatus = document.getElementById("cosBatchStatus");
  const cosBatchPreview = document.getElementById("cosBatchPreview");

  /* ---------- Token helpers ---------- */
  function getToken() {
    try {
      return sessionStorage.getItem(TOKEN_KEY) || "";
    } catch (_) {
      return "";
    }
  }
  function setToken(tok) {
    try {
      if (tok) sessionStorage.setItem(TOKEN_KEY, tok);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch (_) {}
  }

  /* ---------- Escape ---------- */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatNumber(n) {
    const num = Number(n) || 0;
    return num.toLocaleString("zh-CN");
  }

  /* ---------- Login ---------- */
  function showLogin() {
    loginScreen.hidden = false;
    dashboard.hidden = true;
    loginPassword.value = "";
    loginError.hidden = true;
    setTimeout(() => loginPassword.focus(), 50);
  }

  function showDashboard() {
    loginScreen.hidden = true;
    dashboard.hidden = false;
  }

  loginForm.addEventListener("submit", function (e) {
    e.preventDefault();
    loginError.hidden = true;
    const password = loginPassword.value;
    fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: password }),
    })
      .then(function (r) {
        if (r.status === 401) {
          throw new Error("密码错误");
        }
        if (!r.ok) throw new Error("登录失败 (" + r.status + ")");
        return r.json();
      })
      .then(function (data) {
        if (!data || !data.ok || !data.token) throw new Error("登录失败");
        setToken(data.token);
        showDashboard();
        loadOverview();
      })
      .catch(function (err) {
        loginError.textContent = (err && err.message) || "登录失败";
        loginError.hidden = false;
      });
  });

  logoutBtn.addEventListener("click", function () {
    setToken("");
    showLogin();
  });

  /* ---------- Tab switching ---------- */
  function activateTab(name) {
    tabs.forEach(function (t) {
      t.classList.toggle("active", t.getAttribute("data-tab") === name);
    });
    tabOverview.hidden = name !== "overview";
    tabLibrary.hidden = name !== "library";
    if (name === "library") loadLibrary();
  }
  tabs.forEach(function (t) {
    t.addEventListener("click", function () {
      activateTab(t.getAttribute("data-tab"));
    });
  });

  /* ---------- Upload mode switching ---------- */
  function activateUploadMode(mode) {
    uploadModeBtns.forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-mode") === mode);
    });
    uploadFormPane.hidden = mode !== "form";
    uploadJsonPane.hidden = mode !== "json";
    uploadFilePane.hidden = mode !== "file";
    if (uploadCosPane) uploadCosPane.hidden = mode !== "cos";
  }
  uploadModeBtns.forEach(function (b) {
    b.addEventListener("click", function () {
      activateUploadMode(b.getAttribute("data-mode"));
    });
  });

  /* ---------- Visual batch form ---------- */
  function addEpisodeRow(container) {
    const node = episodeRowTpl.content.firstElementChild.cloneNode(true);
    node.querySelector("[data-del-ep]").addEventListener("click", function () {
      node.remove();
    });
    container.appendChild(node);
  }

  function addSeriesForm() {
    const node = seriesFormTpl.content.firstElementChild.cloneNode(true);
    const idx = seriesForms.children.length + 1;
    node.querySelector(".series-form-title").textContent = "作品 " + idx;
    node.querySelector("[data-del-series]").addEventListener("click", function () {
      node.remove();
      // renumber
      Array.prototype.forEach.call(seriesForms.children, function (c, i) {
        const t = c.querySelector(".series-form-title");
        if (t) t.textContent = "作品 " + (i + 1);
      });
    });
    node.querySelector("[data-add-ep]").addEventListener("click", function () {
      addEpisodeRow(node.querySelector("[data-eps]"));
    });
    // seed with one episode
    addEpisodeRow(node.querySelector("[data-eps]"));
    seriesForms.appendChild(node);
  }

  addSeriesBtn.addEventListener("click", addSeriesForm);

  function collectSeries() {
    const out = [];
    Array.prototype.forEach.call(seriesForms.children, function (card) {
      const f = {};
      card.querySelectorAll("[data-f]").forEach(function (el) {
        f[el.getAttribute("data-f")] = el.value.trim();
      });
      const eps = [];
      card.querySelectorAll("[data-ep]").forEach(function (epRow) {
        const e = {};
        epRow.querySelectorAll("[data-f]").forEach(function (el) {
          e[el.getAttribute("data-f")] = el.value.trim();
        });
        if (e.src) eps.push(e);
      });
      if (f.id && eps.length) {
        f.episodes = eps;
        delete f.ep;
        out.push(f);
      }
    });
    return out;
  }

  submitSeriesBtn.addEventListener("click", function () {
    const series = collectSeries();
    if (!series.length) {
      uploadStatus.textContent = "请至少填写一部作品（含作品 ID 与至少一集视频地址）";
      uploadStatus.className = "upload-status err";
      return;
    }
    uploadStatus.textContent = "上传中…";
    uploadStatus.className = "upload-status";
    submitSeriesBtn.disabled = true;
    postImport({ series: series }, function (ok, msg) {
      submitSeriesBtn.disabled = false;
      uploadStatus.textContent = msg;
      uploadStatus.className = "upload-status " + (ok ? "ok" : "err");
      if (ok) {
        seriesForms.innerHTML = "";
        addSeriesForm();
        loadLibrary();
      }
    });
  });

  /* ---------- JSON paste ---------- */
  submitJsonBtn.addEventListener("click", function () {
    const text = jsonInput.value.trim();
    if (!text) {
      jsonStatus.textContent = "请粘贴 JSON";
      jsonStatus.className = "upload-status err";
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      jsonStatus.textContent = "JSON 解析失败：" + e.message;
      jsonStatus.className = "upload-status err";
      return;
    }
    let body = parsed;
    if (Array.isArray(parsed)) body = { series: parsed };
    else if (parsed && Array.isArray(parsed.series)) body = parsed;
    else if (parsed && parsed.id) body = { series: [parsed] };
    jsonStatus.textContent = "上传中…";
    jsonStatus.className = "upload-status";
    submitJsonBtn.disabled = true;
    postImport(body, function (ok, msg) {
      submitJsonBtn.disabled = false;
      jsonStatus.textContent = msg;
      jsonStatus.className = "upload-status " + (ok ? "ok" : "err");
      if (ok) loadLibrary();
    });
  });

  /* ---------- File upload ---------- */
  let pendingFiles = [];
  fileInput.addEventListener("change", function () {
    pendingFiles = Array.prototype.slice.call(fileInput.files || []);
    renderFilePreview();
  });

  if (fileDrop) {
    ["dragover", "dragenter"].forEach(function (ev) {
      fileDrop.addEventListener(ev, function (e) {
        e.preventDefault();
        fileDrop.classList.add("drag");
      });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      fileDrop.addEventListener(ev, function (e) {
        e.preventDefault();
        fileDrop.classList.remove("drag");
      });
    });
    fileDrop.addEventListener("drop", function (e) {
      const files = (e.dataTransfer && e.dataTransfer.files) || [];
      pendingFiles = Array.prototype.slice.call(files).filter(function (f) {
        return /\.json$/i.test(f.name) || f.type === "application/json";
      });
      renderFilePreview();
    });
  }

  function renderFilePreview() {
    submitFileBtn.disabled = pendingFiles.length === 0;
    if (!pendingFiles.length) {
      filePreview.innerHTML = "";
      return;
    }
    filePreview.innerHTML = pendingFiles
      .map(function (f, i) {
        return (
          '<div class="upload-file-item">📄 ' +
          esc(f.name) +
          ' <span class="admin-muted">(' +
          (f.size || 0) +
          " bytes)</span></div>"
        );
      })
      .join("");
  }

  submitFileBtn.addEventListener("click", function () {
    if (!pendingFiles.length) return;
    const fd = new FormData();
    pendingFiles.forEach(function (f) {
      fd.append("file", f, f.name);
    });
    fd.append("mode", replaceMode.checked ? "replace" : "append");
    fileStatus.textContent = "上传中…";
    fileStatus.className = "upload-status";
    submitFileBtn.disabled = true;
    fetch("/api/import/file", {
      method: "POST",
      headers: { Authorization: "Bearer " + getToken() },
      body: fd,
    })
      .then(function (r) {
        return r.json().then(function (d) {
          return { ok: r.ok && d.ok, d: d };
        });
      })
      .then(function (res) {
        submitFileBtn.disabled = false;
        const msg = res.ok
          ? "成功导入 " + res.d.added + " 部作品"
          : "失败：" + (res.d.error || res.d.err || "未知错误");
        fileStatus.textContent = msg;
        fileStatus.className = "upload-status " + (res.ok ? "ok" : "err");
        if (res.ok) {
          pendingFiles = [];
          fileInput.value = "";
          renderFilePreview();
          loadLibrary();
        }
      })
      .catch(function (err) {
        submitFileBtn.disabled = false;
        fileStatus.textContent = "请求异常：" + (err && err.message);
        fileStatus.className = "upload-status err";
      });
  });

  /* ---------- Tencent COS import ---------- */
  function cosPayload() {
    return {
      prefix: (cosPrefix.value || "").trim(),
      title: (cosTitle.value || "").trim(),
      id: (cosId.value || "").trim(),
      category: (cosCategory.value || "").trim(),
      author: (cosAuthor.value || "").trim(),
      description: (cosDescription.value || "").trim(),
    };
  }

  function renderCosPreview(data) {
    if (!data || !data.series) {
      cosPreview.hidden = true;
      cosPreview.innerHTML = "";
      return;
    }
    const s = data.series;
    const m = data.meta || {};
    const eps = (s.episodes || [])
      .map(function (ep) {
        return (
          '<li><span class="cos-ep-num">EP' +
          ep.ep +
          "</span> " +
          esc(ep.title) +
          ' <span class="admin-muted">' +
          esc((ep.src || "").slice(0, 90)) +
          (ep.src && ep.src.length > 90 ? "…" : "") +
          "</span></li>"
        );
      })
      .join("");
    const cover = s.thumbnail
      ? '<img src="' + esc(s.thumbnail) + '" alt="封面" class="cos-cover" />'
      : '<div class="cos-cover cos-cover-empty">暂无封面图</div>';
    cosPreview.innerHTML =
      '<div class="cos-preview-head">' +
      cover +
      "<div>" +
      "<h3>" + esc(s.title) + "</h3>" +
      '<p class="admin-muted">作品 ID: ' + esc(s.id) +
      " · 共扫描 " + (m.scanned || 0) + " 个对象 · 识别 " + (m.video_count || eps.length) + " 集 · 封面: " +
      (m.cover_key ? esc(m.cover_key) : "<i>无</i>") +
      "</p></div></div>" +
      "<ul class=\"cos-ep-list\">" + eps + "</ul>";
    cosPreview.hidden = false;
  }

  function cosRequest(url, cb) {
    const body = cosPayload();
    if (!body.prefix) {
      cosStatus.textContent = "请填写 COS 对象路径";
      cosStatus.className = "upload-status err";
      return;
    }
    cosStatus.textContent = "处理中…";
    cosStatus.className = "upload-status";
    cosPreviewBtn.disabled = true;
    cosImportBtn.disabled = true;
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + getToken(),
      },
      body: JSON.stringify(body),
    })
      .then(function (r) {
        return r.json().then(function (d) {
          return { ok: r.ok && d.ok, d: d };
        });
      })
      .then(function (res) {
        cosPreviewBtn.disabled = false;
        cosImportBtn.disabled = false;
        cb(res);
      })
      .catch(function (err) {
        cosPreviewBtn.disabled = false;
        cosImportBtn.disabled = false;
        cosStatus.textContent = "请求异常：" + (err && err.message);
        cosStatus.className = "upload-status err";
      });
  }

  if (cosPreviewBtn) {
    cosPreviewBtn.addEventListener("click", function () {
      cosRequest("/api/cos/preview", function (res) {
        if (!res.ok) {
          cosStatus.textContent = "预览失败：" + (res.d.error || "未知错误");
          cosStatus.className = "upload-status err";
          renderCosPreview(null);
          return;
        }
        const m = res.d.meta || {};
        cosStatus.textContent =
          "扫描完成：识别 " + (m.video_count || 0) + " 集，可直接导入";
        cosStatus.className = "upload-status ok";
        renderCosPreview(res.d);
      });
    });
  }

  if (cosImportBtn) {
    cosImportBtn.addEventListener("click", function () {
      cosRequest("/api/cos/import", function (res) {
        if (!res.ok) {
          cosStatus.textContent = "导入失败：" + (res.d.error || "未知错误");
          cosStatus.className = "upload-status err";
          return;
        }
        cosStatus.textContent =
          "导入成功：已上架作品《" +
          (res.d.series ? res.d.series.title : "") +
          "》，共 " +
          (res.d.series ? (res.d.series.episodes || []).length : 0) +
          " 集";
        cosStatus.className = "upload-status ok";
        renderCosPreview({ series: res.d.series, meta: res.d.meta });
        loadLibrary();
      });
    });
  }

  /* ---------- COS: parent-folder batch import ---------- */

  function activateCosSub(mode) {
    cosSubBtns.forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-sub") === mode);
    });
    if (uploadCosSingle) uploadCosSingle.hidden = mode !== "single";
    if (uploadCosBatch) uploadCosBatch.hidden = mode !== "batch";
  }
  cosSubBtns.forEach(function (b) {
    b.addEventListener("click", function () {
      activateCosSub(b.getAttribute("data-sub"));
    });
  });

  function cosBatchPayload() {
    return {
      prefix: (cosBatchPrefix.value || "").trim(),
      category: (cosBatchCategory.value || "").trim(),
      author: (cosBatchAuthor.value || "").trim(),
    };
  }

  function renderCosBatchPreview(data) {
    if (!data || !Array.isArray(data.series) || !data.series.length) {
      cosBatchPreview.hidden = true;
      cosBatchPreview.innerHTML = "";
      return;
    }
    const m = data.meta || {};
    const failures = Array.isArray(data.failures) ? data.failures : [];
    const rows = data.series
      .map(function (s, i) {
        const cover = s.thumbnail
          ? '<img src="' + esc(s.thumbnail) + '" class="cos-batch-cover" alt="" />'
          : '<div class="cos-batch-cover cos-batch-cover--empty">无封面</div>';
        return (
          '<li class="cos-batch-row">' +
          cover +
          '<div class="cos-batch-meta">' +
          '<div class="cos-batch-title">' +
          (i + 1) +
          ". " +
          esc(s.title) +
          "</div>" +
          '<div class="admin-muted">ID: ' +
          esc(s.id) +
          " · 集数: " +
          (s.episode_count || 0) +
          " · 路径: " +
          esc(s.scan_prefix || "") +
          "</div>" +
          "</div>" +
          "</li>"
        );
      })
      .join("");

    const failBlock = failures.length
      ? '<div class="cos-batch-fail"><strong>⚠️ 跳过 ' +
        failures.length +
        " 个子文件夹：</strong><ul>" +
        failures
          .map(function (f) {
            return (
              "<li>" +
              esc(f.name || f.prefix) +
              " — <span class=\"admin-muted\">" +
              esc(f.error || "未知错误") +
              "</span></li>"
            );
          })
          .join("") +
        "</ul></div>"
      : "";

    cosBatchPreview.innerHTML =
      '<div class="cos-preview-head"><div>' +
      "<h3>🗂️ 父目录扫描结果</h3>" +
      '<p class="admin-muted">父路径: ' +
      esc(m.parent_prefix || "") +
      " · 子文件夹: " +
      (m.scanned_folders || 0) +
      " · 可导入作品: " +
      (m.built_series || data.series.length) +
      " · 跳过: " +
      (m.failed_folders || failures.length || 0) +
      "</p></div></div>" +
      '<ul class="cos-batch-list">' +
      rows +
      "</ul>" +
      failBlock;
    cosBatchPreview.hidden = false;
  }

  function cosBatchRequest(url, cb) {
    const body = cosBatchPayload();
    if (!body.prefix) {
      cosBatchStatus.textContent = "请填写父目录路径";
      cosBatchStatus.className = "upload-status err";
      return;
    }
    cosBatchStatus.textContent = "扫描中…（子文件夹较多时请耐心等待）";
    cosBatchStatus.className = "upload-status";
    cosBatchPreviewBtn.disabled = true;
    cosBatchImportBtn.disabled = true;
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + getToken(),
      },
      body: JSON.stringify(body),
    })
      .then(function (r) {
        return r.json().then(function (d) {
          return { ok: r.ok && d.ok, d: d };
        });
      })
      .then(function (res) {
        cosBatchPreviewBtn.disabled = false;
        cosBatchImportBtn.disabled = false;
        cb(res);
      })
      .catch(function (err) {
        cosBatchPreviewBtn.disabled = false;
        cosBatchImportBtn.disabled = false;
        cosBatchStatus.textContent = "请求异常：" + (err && err.message);
        cosBatchStatus.className = "upload-status err";
      });
  }

  if (cosBatchPreviewBtn) {
    cosBatchPreviewBtn.addEventListener("click", function () {
      cosBatchRequest("/api/cos/batch_preview", function (res) {
        if (!res.ok) {
          cosBatchStatus.textContent =
            "预览失败：" + (res.d.error || "未知错误");
          cosBatchStatus.className = "upload-status err";
          renderCosBatchPreview(null);
          return;
        }
        const m = res.d.meta || {};
        cosBatchStatus.textContent =
          "扫描完成：发现 " +
          (m.built_series || 0) +
          " 部作品" +
          (m.failed_folders ? "（跳过 " + m.failed_folders + " 个）" : "") +
          "，确认无误后点击“批量导入”";
        cosBatchStatus.className = "upload-status ok";
        renderCosBatchPreview(res.d);
      });
    });
  }

  if (cosBatchImportBtn) {
    cosBatchImportBtn.addEventListener("click", function () {
      if (
        !window.confirm(
          "将把父目录下每个子文件夹作为一部短剧批量导入，是否继续？"
        )
      ) {
        return;
      }
      cosBatchRequest("/api/cos/batch_import", function (res) {
        if (!res.ok) {
          cosBatchStatus.textContent =
            "导入失败：" + (res.d.error || "未知错误");
          cosBatchStatus.className = "upload-status err";
          return;
        }
        cosBatchStatus.textContent =
          "✅ 已批量导入 " +
          (res.d.added || 0) +
          " 部短剧" +
          (res.d.failures && res.d.failures.length
            ? "（跳过 " + res.d.failures.length + " 个无效文件夹）"
            : "");
        cosBatchStatus.className = "upload-status ok";
        renderCosBatchPreview({
          series: (res.d.series || []).map(function (s) {
            return {
              id: s.id,
              title: s.title,
              thumbnail: "",
              episode_count: s.episode_count,
              scan_prefix: "",
            };
          }),
          meta: res.d.meta,
          failures: res.d.failures,
        });
        loadLibrary();
      });
    });
  }

  /* ---------- Shared import caller ---------- */
  function postImport(body, cb) {
    fetch("/api/import", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + getToken(),
      },
      body: JSON.stringify(body),
    })
      .then(function (r) {
        return r.json().then(function (d) {
          return { ok: r.ok && d.ok, d: d };
        });
      })
      .then(function (res) {
        cb(
          res.ok,
          res.ok
            ? "成功导入 " + res.d.added + " 部作品"
            : "失败：" + (res.d.error || "未知错误")
        );
      })
      .catch(function (err) {
        cb(false, "请求异常：" + (err && err.message));
      });
  }

  /* ---------- Library list ---------- */
  function loadLibrary() {
    if (tabLibrary.hidden) return;
    fetch("/api/library")
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (data) {
        const list = (data && data.imported) || [];
        if (!list.length) {
          libraryTbody.innerHTML =
            '<tr class="empty-row"><td colspan="6">暂无作品，请在上方批量上传</td></tr>';
          return;
        }
        libraryTbody.innerHTML = list
          .map(function (s, i) {
            const epCount = (s.episodes || []).length;
            const safeId = esc(s.id);
            return (
              "<tr>" +
              "<td>" +
              (i + 1) +
              "</td>" +
              "<td>" +
              safeId +
              "</td>" +
              "<td>" +
              esc(s.title) +
              "</td>" +
              "<td>" +
              esc(s.category) +
              "</td>" +
              '<td class="num">' +
              epCount +
              "</td>" +
              '<td class="row-actions">' +
              '<a class="btn-link" target="_blank" href="player.html?id=' +
              encodeURIComponent(s.id) +
              '">查看</a>' +
              ' <button type="button" class="btn-link btn-link-danger" data-del-series-id="' +
              safeId +
              '" data-del-series-title="' +
              esc(s.title) +
              '">🗑️ 删除</button>' +
              "</td>" +
              "</tr>"
            );
          })
          .join("");

        // Bind row-level delete handlers after render.
        libraryTbody
          .querySelectorAll("button[data-del-series-id]")
          .forEach(function (btn) {
            btn.addEventListener("click", function () {
              const id = btn.getAttribute("data-del-series-id");
              const title = btn.getAttribute("data-del-series-title") || id;
              deleteSeries(id, title);
            });
          });
      })
      .catch(function () {});
  }
  reloadLibraryBtn.addEventListener("click", loadLibrary);

  function deleteSeries(id, title) {
    if (!id) return;
    if (!window.confirm('确认删除作品《' + title + '》？此操作不可恢复。')) {
      return;
    }
    fetch("/api/library/" + encodeURIComponent(id), {
      method: "DELETE",
      headers: { Authorization: "Bearer " + getToken() },
    })
      .then(function (r) {
        return r.json().then(function (d) {
          return { ok: r.ok && d.ok, d: d, status: r.status };
        });
      })
      .then(function (res) {
        if (!res.ok) {
          window.alert(
            "删除失败：" + ((res.d && res.d.error) || "HTTP " + res.status)
          );
          return;
        }
        loadLibrary();
      })
      .catch(function (err) {
        window.alert("请求异常：" + (err && err.message));
      });
  }

  const clearLibraryBtn = document.getElementById("clearLibraryBtn");
  if (clearLibraryBtn) {
    clearLibraryBtn.addEventListener("click", function () {
      if (
        !window.confirm(
          "⚠️ 此操作会清空全部已上传作品，且不可恢复。\n\n确定要继续吗？"
        )
      ) {
        return;
      }
      if (
        !window.confirm(
          "最后一次确认：真的要清空全部作品吗？"
        )
      ) {
        return;
      }
      fetch("/api/library?confirm=yes", {
        method: "DELETE",
        headers: { Authorization: "Bearer " + getToken() },
      })
        .then(function (r) {
          return r.json().then(function (d) {
            return { ok: r.ok && d.ok, d: d, status: r.status };
          });
        })
        .then(function (res) {
          if (!res.ok) {
            window.alert(
              "清空失败：" +
                ((res.d && res.d.error) || "HTTP " + res.status)
            );
            return;
          }
          window.alert("已清空 " + (res.d.removed || 0) + " 部作品");
          loadLibrary();
        })
        .catch(function (err) {
          window.alert("请求异常：" + (err && err.message));
        });
    });
  }

  /* ---------- Load dashboard data ---------- */
  function loadOverview() {
    const token = getToken();
    if (!token) {
      showLogin();
      return;
    }
    refreshBtn.disabled = true;
    refreshBtn.textContent = "加载中…";

    fetch("/api/admin/overview?token=" + encodeURIComponent(token), {
      headers: { Authorization: "Bearer " + token },
    })
      .then(function (r) {
        if (r.status === 401) {
          setToken("");
          showLogin();
          throw new Error("会话已过期，请重新登录");
        }
        if (!r.ok) throw new Error("请求失败 (" + r.status + ")");
        return r.json();
      })
      .then(function (data) {
        if (!data || !data.ok) throw new Error("返回数据异常");
        renderAll(data);
      })
      .catch(function (err) {
        console.error("[admin] load failed", err);
      })
      .then(function () {
        refreshBtn.disabled = false;
        refreshBtn.textContent = "刷新";
      });
  }

  /* ---------- Render ---------- */
  function renderAll(data) {
    generatedAt.textContent = "数据生成于 " + (data.generated_at || "-");

    renderKpis(data);
    renderUvChart(data.visits && data.visits.last_30_days);
    renderAdsTable(data.ads && data.ads.slots);
    renderVideosTable(data.videos && data.videos.episodes);
  }

  function renderKpis(data) {
    const visits = data.visits || {};
    const videos = (data.videos && data.videos.totals) || {};
    const adsTot = (data.ads && data.ads.totals) || {};

    kpiUvToday.textContent = formatNumber(visits.today || 0);
    kpiUv30.textContent = formatNumber(visits.total_30d || 0);

    kpiPlays.textContent = formatNumber(videos.plays || 0);
    kpiOpens.textContent = formatNumber(videos.opens || 0);
    kpiEnds.textContent = formatNumber(videos.ends || 0);

    kpiAdClicks.textContent = formatNumber(adsTot.clicks || 0);
    kpiAdImpr.textContent = formatNumber(adsTot.impressions || 0);
    kpiAdCtr.textContent = (adsTot.ctr || 0).toFixed(2) + "%";
  }

  function renderUvChart(series) {
    if (!Array.isArray(series) || !series.length) {
      uvChart.innerHTML = '<div class="admin-muted">暂无访问数据</div>';
      return;
    }
    const max = Math.max.apply(
      null,
      series.map(function (p) {
        return p.uv || 0;
      })
    );
    const safeMax = max > 0 ? max : 1;
    uvChart.innerHTML = series
      .map(function (p) {
        const pct = Math.round(((p.uv || 0) / safeMax) * 100);
        const h = p.uv > 0 ? Math.max(pct, 4) : 0;
        return (
          '<div class="uv-bar" data-uv="' +
          esc(p.uv) +
          '" style="height:' +
          h +
          '%">' +
          '<span class="uv-tip">' +
          esc(p.date) +
          "：" +
          esc(formatNumber(p.uv)) +
          " 人</span>" +
          "</div>"
        );
      })
      .join("");
  }

  function renderAdsTable(slots) {
    if (!slots || typeof slots !== "object") {
      adsTbody.innerHTML =
        '<tr class="empty-row"><td colspan="4">暂无广告数据</td></tr>';
      return;
    }
    const rows = Object.keys(slots).map(function (slot) {
      const row = slots[slot] || {};
      const label = AD_SLOT_LABELS[slot] || slot;
      return (
        "<tr>" +
        '<td><span class="slot-tag">' +
        esc(slot) +
        "</span> " +
        esc(label) +
        "</td>" +
        '<td class="num">' +
        formatNumber(row.impressions) +
        "</td>" +
        '<td class="num">' +
        formatNumber(row.clicks) +
        "</td>" +
        '<td class="num">' +
        (Number(row.ctr) || 0).toFixed(2) +
        "%</td>" +
        "</tr>"
      );
    });
    adsTbody.innerHTML =
      rows.join("") ||
      '<tr class="empty-row"><td colspan="4">暂无广告数据</td></tr>';
  }

  function renderVideosTable(episodeMap) {
    if (!episodeMap || typeof episodeMap !== "object") {
      videosTbody.innerHTML =
        '<tr class="empty-row"><td colspan="7">暂无视频播放数据</td></tr>';
      return;
    }

    // Join episode stats with videos.js so we can display human
    // titles. Fall back to the raw id when the series is not in the
    // built-in catalog (e.g. imported after the admin page loaded).
    const Catalog = window.VideoCatalog;
    const seriesMap = {};
    (window.VIDEOS || []).forEach(function (s) {
      seriesMap[s.id] = s;
    });

    const rows = Object.keys(episodeMap)
      .map(function (key) {
        const entry = episodeMap[key] || {};
        // Key may be "<seriesId>:ep<n>" or legacy "<id>".
        const m = /^(.*):ep(\d+)$/.exec(key);
        let seriesId = key;
        let epNum = "";
        if (m) {
          seriesId = m[1];
          epNum = m[2];
        }
        const series = seriesMap[seriesId];
        const seriesTitle = series ? series.title : seriesId;
        const episode =
          series && Catalog ? Catalog.findEpisode(series, Number(epNum)) : null;
        const epTitle = episode ? episode.title : epNum ? "第" + epNum + "集" : "";

        const opens = Number(entry.opens) || 0;
        const plays = Number(entry.plays) || 0;
        const ends = Number(entry.ends) || 0;
        const finishRate = plays > 0 ? (ends / plays) * 100 : 0;
        return {
          seriesTitle: seriesTitle,
          epTitle: epTitle,
          opens: opens,
          plays: plays,
          ends: ends,
          finishRate: finishRate,
        };
      })
      .sort(function (a, b) {
        return b.plays - a.plays;
      });

    if (!rows.length) {
      videosTbody.innerHTML =
        '<tr class="empty-row"><td colspan="7">暂无视频播放数据</td></tr>';
      return;
    }

    videosTbody.innerHTML = rows
      .map(function (r, i) {
        return (
          "<tr>" +
          "<td>" +
          (i + 1) +
          "</td>" +
          "<td>" +
          esc(r.seriesTitle) +
          "</td>" +
          "<td>" +
          esc(r.epTitle) +
          "</td>" +
          '<td class="num">' +
          formatNumber(r.opens) +
          "</td>" +
          '<td class="num"><strong>' +
          formatNumber(r.plays) +
          "</strong></td>" +
          '<td class="num">' +
          formatNumber(r.ends) +
          "</td>" +
          '<td class="num">' +
          r.finishRate.toFixed(1) +
          "%</td>" +
          "</tr>"
        );
      })
      .join("");
  }

  /* ---------- Boot ---------- */
  document.addEventListener("DOMContentLoaded", function () {
    // Also load the imported library so the videos table can show
    // human-readable titles for user-imported series.
    fetch("/api/library")
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (data) {
        if (
          data &&
          Array.isArray(data.imported) &&
          window.VideoCatalog &&
          window.VideoCatalog.mergeImported
        ) {
          window.VideoCatalog.mergeImported(data.imported);
        }
      })
      .catch(function () {})
      .then(function () {
        if (getToken()) {
          showDashboard();
          loadOverview();
          // Seed the upload form with one blank series.
          addSeriesForm();
        } else {
          showLogin();
        }
      });
  });
})();
