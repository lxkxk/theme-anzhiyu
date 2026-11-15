/**
 * MetingJS 音乐接口容错补丁
 *
 * 背景：
 *   播放器只信任 Meting 接口返回的音频地址。第三方接口一旦出问题（例如 api.i-meto.com 的
 *   type=url 接口突然大量返回 404），<audio> 会触发 error 事件，APlayer 内置逻辑会在 2 秒后
 *   自动 skipForward() 切到下一首；如果歌单里每首歌都失败，表现就是“接口请求成功、歌词也有，
 *   但一直没有声音，而且一直在换下一首”。
 *
 * 这个补丁做两件事：
 *   1. 某首歌播放失败时，用同一首歌的 id 到备用接口重试（同步替换 url / lrc）。
 *      重试走 list.switch()，它会触发 listswitch，从而清掉 APlayer 内置的 2 秒自动切歌定时器；
 *   2. 所有接口、所有歌曲都失败时，暂停并提示，而不是无休止地自动切歌。
 *
 * 一切正常时只给歌曲对象打一个轻量标记，不会产生额外请求。
 */
(function () {
  "use strict";

  // 备用 Meting 接口，按顺序尝试；:server / :type / :id 会被实际值替换
  var FALLBACK_APIS = [
    "https://api.injahow.cn/meting/?server=:server&type=:type&id=:id",
    "https://api.i-meto.com/meting/api?server=:server&type=:type&id=:id&r=:r",
  ];

  var MetingElement = window.MetingJSElement;
  if (!MetingElement || !MetingElement.prototype || !window.APlayer) {
    return;
  }

  function buildUrl(template, server, type, id) {
    return template
      .replace(":server", server || "netease")
      .replace(":type", type)
      .replace(":id", id)
      .replace(":r", String(Math.random()));
  }

  // 接口基地址（域名 + 路径），用来判断某首歌当前是否已经用了这个接口
  function endpointOf(url) {
    try {
      var parsed = new URL(url, window.location.href);
      return parsed.origin + parsed.pathname;
    } catch (error) {
      return "";
    }
  }

  function getId(song) {
    var candidates = [song.url, song.lrc, song.pic];
    for (var i = 0; i < candidates.length; i++) {
      var match = /[?&]id=([^&]+)/.exec(candidates[i] || "");
      if (match) return decodeURIComponent(match[1]);
    }
    return "";
  }

  function decorate(songs, server) {
    songs.forEach(function (song) {
      if (!song || song.__metingFallbacks) return;
      song.__metingFallbacks = [];
      var id = getId(song);
      if (!id) return;
      var current = endpointOf(song.url);
      FALLBACK_APIS.forEach(function (template) {
        var url = buildUrl(template, server, "url", id);
        if (endpointOf(url) === current) return;
        song.__metingFallbacks.push({
          url: url,
          lrc: buildUrl(template, server, "lrc", id),
        });
      });
    });
  }

  function bindGuard(aplayer) {
    if (!aplayer || !aplayer.list || aplayer.__metingGuard) return;
    aplayer.__metingGuard = true;

    var failed = {};
    var lastErrorAt = 0;

    if (aplayer.events && typeof aplayer.events.on === "function") {
      aplayer.events.on("listswitch", function () {
        // 距上次报错超过 3 秒说明是用户手动切歌，重置计数，给一次新的尝试机会
        if (Date.now() - lastErrorAt > 3000) failed = {};
      });
    }

    aplayer.on("playing", function () {
      failed = {};
    });

    aplayer.on("error", function () {
      lastErrorAt = Date.now();
      var index = aplayer.list.index;
      var song = aplayer.list.audios[index];
      if (!song) return;

      var fallbacks = song.__metingFallbacks || [];
      if (fallbacks.length > 0) {
        var next = fallbacks.shift();
        song.url = next.url;
        if (next.lrc) song.lrc = next.lrc;
        // 走 list.switch 既会重新加载同一首歌，也会清掉 APlayer 的自动切歌定时器
        aplayer.list.switch(index);
        return;
      }

      failed[index] = true;
      var total = aplayer.list.audios.length;
      if (Object.keys(failed).length < total) return; // 还有没试过的歌，交给 APlayer 自动切

      // 所有歌都失败了：清掉 APlayer 的自动切歌定时器并停下，避免无限“自动下一首”
      if (aplayer.events && typeof aplayer.events.trigger === "function") {
        aplayer.events.trigger("listswitch", { index: index });
      }
      aplayer.pause();
      var message = "音乐加载失败：接口没有返回可播放的音频地址，请稍后重试";
      if (typeof aplayer.notice === "function") aplayer.notice(message, 5000);
      if (window.anzhiyu && typeof window.anzhiyu.snackbarShow === "function") {
        window.anzhiyu.snackbarShow(message, false, 5000);
      }
    });
  }

  var prototype = MetingElement.prototype;
  if (typeof prototype._loadPlayer !== "function") return;
  var originalLoadPlayer = prototype._loadPlayer;

  prototype._loadPlayer = function (songs) {
    try {
      if (Array.isArray(songs) && songs.length > 0) {
        decorate(songs, this.meta && this.meta.server);
      }
    } catch (error) {
      console.warn("[meting-fallback] decorate failed:", error);
    }
    var result = originalLoadPlayer.call(this, songs);
    try {
      bindGuard(this.aplayer);
    } catch (error) {
      console.warn("[meting-fallback] bind guard failed:", error);
    }
    return result;
  };
})();
