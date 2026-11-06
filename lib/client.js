/**
 * dsh-desktop-shot — 客户端半边（client half）
 *
 * 只做两件事：
 *   1. 输入框右侧座位放一个按钮，点它让宿主**把 DSH 窗口收起来并自动弹出框选工具**；
 *   2. 窗口回到前台时问一次宿主结果——截到了就提示「直接 Ctrl+V 粘贴」，取消/超时/失败
 *      也各给一句话。
 *
 * 框选工具是宿主自己拉的（`lib/index.mjs` 里的 C# 遮罩），不需要你去开 Win+Shift+S；
 * 页面这边不抓屏（桌面壳把 `getDisplayMedia` 拒了），也不做遮罩——"插件自己抓屏 →
 * 藏起来又马上还回来"正是 0.1.x 点击时"顿一下、闪一下"的根源。
 *
 * 客户端代码改动不用重启 DSH（宿主会 stat-poll `client.js` 并热换模块）；
 * 宿主半边（`lib/index.mjs`）改了必须重启。
 */

window.__ModuleLoader__.load({
	id: "dsh-desktop-shot",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");
		const h = react.createElement;
		const { useState, useRef, useEffect, useCallback } = react;

		const TAG = "[dsh-desktop-shot]";
		const TOKEN_ROUTE = "/api/dsh-desktop-shot/token";
		const MINIMIZE_ROUTE = "/api/dsh-desktop-shot/minimize";
		const STATUS_ROUTE = "/api/dsh-desktop-shot/status";
		const CROP_ROUTE = "/api/dsh-desktop-shot/last-crop";
		const TRACE_ROUTE = "/api/dsh-desktop-shot/trace";
		const TOKEN_HEADER = "x-dsh-desktop-shot-token";
		const Z_TOAST = 2147483000;
		const POLL_MS = 700;
		/** 宿主单次 PowerShell 调用已带 20s 兜底；这里再放宽一档，避免误杀正常路径。 */
		const REQUEST_TIMEOUT_MS = 25000;

		/**
		 * 宿主每次启动发放的一次性令牌。宿主路由只监听本机回环，任何本机进程都能 POST，
		 * 浏览器还会替跨站页面发"简单"POST，所以业务路由都要求这个头。
		 * 令牌本身从 `/token` 取——跨站页面读不到它：响应没有 CORS 许可，浏览器不会把 body 交给对方。
		 */
		let routeToken = null;
		let tokenRequest = null;

		async function ensureToken() {
			if (routeToken !== null) return routeToken;
			if (tokenRequest === null) {
				tokenRequest = fetch(TOKEN_ROUTE, { method: "POST" })
					.then((response) => (response.ok ? response.json() : null))
					.then((body) => (body?.ok === true && typeof body.value?.token === "string" ? body.value.token : null))
					.catch(() => null)
					.then((token) => {
						routeToken = token;
						tokenRequest = null;
						return token;
					});
			}
			return tokenRequest;
		}

		/**
		 * 带令牌与超时的宿主请求。
		 * 超时是必要的：上一版宿主可能永远不返回，客户端的 `busy` 就会永久为 true、按钮再也点不动。
		 */
		async function fetchWithToken(route, body) {
			let token = await ensureToken();
			const send = async () => {
				const controller = new AbortController();
				const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
				try {
					return await fetch(route, {
						method: "POST",
						headers: { "content-type": "application/json", [TOKEN_HEADER]: token ?? "" },
						body: typeof body === "string" ? body : "{}",
						signal: controller.signal
					});
				} finally {
					window.clearTimeout(timer);
				}
			};
			const response = await send();
			// 宿主重启会换令牌，而页面里还留着旧的：401 就丢掉重取一次，否则要刷新页面才能再用。
			if (response.status === 401) {
				routeToken = null;
				token = await ensureToken();
				trace("route token was stale; retried with a fresh one");
				return send();
			}
			return response;
		}

		const STRINGS = {
			zh: {
				button: "截图（自动框选并放入消息框）",
				tooltip: "把 DSH 窗口收起来并自动弹出框选工具；选完自动回到输入框并把图放进去",
				delivered: "已放入消息框",
				clipboardOnly: "已截取到剪贴板 —— Ctrl+V 粘贴（自动放入失败）",
				cancelled: "已取消",
				timedOut: "框选超时，窗口已还原",
				toolFailed: "框选工具启动失败，窗口已还原 —— 可临时用 Win+Shift+S",
				failed: "收起窗口失败：",
				noWindow: "找不到 DSH 窗口（可用 DSH_DESKTOP_SHOT_TITLE 指定标题后缀）",
				noMinimize: "窗口没能最小化 —— 可能被系统/权限拦了，看 ~/.dsh/dsh-desktop-shot.log",
				alreadyArmed: "已经在截图了 —— 请先在框选工具里选完或按 Esc",
				reloaded: "截图被中断（插件已重载），窗口已还原"
			},
			en: {
				button: "Capture (select and insert)",
				tooltip: "Hide the DSH window and open the region selector; the crop goes straight into the composer",
				delivered: "Added to the composer",
				clipboardOnly: "Copied to the clipboard — press Ctrl+V (auto-insert failed)",
				cancelled: "Cancelled",
				timedOut: "Region select timed out; the window is back",
				toolFailed: "The selector failed to start; the window is back — you can fall back to Win+Shift+S",
				failed: "Could not hide the window: ",
				noWindow: "Could not find the DSH window (set DSH_DESKTOP_SHOT_TITLE)",
				noMinimize: "The window would not minimize — check ~/.dsh/dsh-desktop-shot.log",
				alreadyArmed: "A capture is already in progress — finish it or press Esc",
				reloaded: "The capture was interrupted (plugin reloaded); the window is back"
			}
		};

		/**
		 * 投递通道 = **composer 自己的隐藏 file input**。
		 *
		 * 为什么不再用 `conversation.input.attachments` 槽位去接 `onAddFiles`：那个槽位是
		 * `kind: "single"`，而它已经被官方附件组件以 priority 0 占着，同优先级再注册会被
		 * 登记表直接拒绝（`single slot "…" already has a registration … (registered by …)`），
		 * 桥根本装不上；若改优先级去抢，就会把官方的草稿缩略图/拖放区顶掉。
		 *
		 * 而 composer 的 file input 本来就是**官方入口之一**（"选择文件"按钮走的就是它），
		 * 它的 onChange 会把 File 交给同一套 intake 校验（图片数量/大小限制），
		 * 比直接调 `onAddFiles` 还严格。所以这里只做一件事：把 File 塞进去并派发 change。
		 */

		/**
		 * 找出 composer 的隐藏 file input。
		 * InputBar 渲染的是 `input[type=file][multiple][hidden]`，onChange 走 `onPickFiles` → intake。
		 * 只认 `multiple` 的：那是 composer 的；页面上其它单文件 input 不该被我们写入。
		 */
		function findComposerFileInput() {
			for (const input of document.querySelectorAll("input[type=file][multiple]")) {
				if (input.disabled) continue;
				return input;
			}
			return null;
		}

		/** 把文件塞进 composer 的 file input（等同用户点"选择文件"并选中它）。 */
		function submitViaFileInput(file) {
			const input = findComposerFileInput();
			if (input === null) return null;
			try {
				const transfer = new DataTransfer();
				transfer.items.add(file);
				input.files = transfer.files;
				return input;
			} catch (error) {
				trace(`file input rejected the file: ${error?.message ?? error}`);
				return null;
			}
		}

		/** 等这一轮真的落地：composer 接受后会自己清空 input（`e.target.value = ""; e.target.files` 变空）。 */
		async function waitForFileInputAccepted(input, timeoutMs) {
			const started = Date.now();
			while (Date.now() - started < timeoutMs) {
				if (input.files === null || input.files.length === 0) return true;
				await sleep(60);
			}
			return false;
		}

		/**
		 * 草稿附件轨道是否真的挂出来了。官方附件组件给轨道加了 `role="group"`，
		 * aria-label 用的是 `conversation` 命名空间的 `attachment.pending`；这里按语义匹配，
		 * 而不是按 CSS module 生成的类名（`*_module_css_default`，随时会变）。
		 */
		function attachmentRailPresent() {
			for (const node of document.querySelectorAll('[role="group"][aria-label]')) {
				if (/(待发送附件|pending attachments)/i.test(node.getAttribute("aria-label") ?? "")) return true;
			}
			return false;
		}

		/**
		 * 取回裁剪结果并投递进草稿。失败时抛错，调用方据此提示"改用 Ctrl+V"——
		 * 框选工具一直把 PNG 放在剪贴板里，所以这条退路始终可用。
		 */
		async function deliverCrop() {
			const file = await fetchCropFile();
			for (let attempt = 0; attempt < 6; attempt++) {
				const input = submitViaFileInput(file);
				if (input !== null) {
					input.dispatchEvent(new Event("change", { bubbles: true }));
					if (await waitForFileInputAccepted(input, 700)) {
						// 接受 ≠ 轨道一定渲染出来了（例如图片超限时它只是不出现）。
						// 这只是诊断，不影响判定：轨道缺失时仍然认为投递成功，因为核心没有拒绝。
						if (!attachmentRailPresent()) trace("attachments accepted, but the draft rail did not appear");
						return { channel: "file-input", size: file.size, verified: true };
					}
				} else {
					trace("no composer file input found");
				}
				trace(`file-input delivery did not land (attempt ${attempt + 1})`);
				await sleep(400);
			}
			throw new Error("the composer file input did not take the crop");
		}

		/**
		 * 等到窗口真正可见、并且画过一帧再投递。
		 * 这次投递发生在窗口刚从最小化还原的几十毫秒内，此时 document 往往还是 hidden——
		 * 而草稿缩略图与核心的图片尺寸探测都要靠解码，hidden 期间会被推迟。
		 */
		function waitForPaint() {
			return new Promise((resolve) => {
				const started = Date.now();
				const step = () => {
					if (typeof document !== "undefined" && document.visibilityState === "visible") {
						if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => window.setTimeout(resolve, 80));
						else window.setTimeout(resolve, 80);
						return;
					}
					if (Date.now() - started > 3000) {
						resolve();
						return;
					}
					window.setTimeout(step, 60);
				};
				step();
			});
		}

		const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

		/** 向宿主要最近一次裁剪的 PNG，包成 File。该路由是一次性的：取走即清。 */
		async function fetchCropFile() {
			const response = await fetchWithToken(CROP_ROUTE);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const blob = await response.blob();
			if (blob.size === 0) throw new Error("empty crop");
			return new File([blob], "desktop-shot.png", { type: "image/png" });
		}

		function strings() {
			const lang = typeof document !== "undefined" ? (document.documentElement.lang || "zh").toLowerCase() : "zh";
			return STRINGS[lang.startsWith("zh") ? "zh" : "en"];
		}

		/** 把关键步骤同时写到宿主日志（页面里的 console 我这边看不到）。 */
		function trace(message) {
			try {
				console.info(TAG, message);
			} catch {
				/* ignore */
			}
			try {
				fetchWithToken(TRACE_ROUTE, JSON.stringify({ message: String(message) })).catch(() => {});
			} catch {
				/* ignore */
			}
		}

		async function postJson(route, body) {
			const response = await fetchWithToken(route, body);
			let parsed = null;
			try {
				parsed = await response.json();
			} catch {
				throw new Error(`HTTP ${response.status}`);
			}
			return { response, body: parsed };
		}

		const buttonStyle = {
			order: 1,
			width: 28,
			height: 28,
			flex: "none",
			display: "grid",
			placeItems: "center",
			padding: 0,
			border: "none",
			borderRadius: 999,
			background: "transparent",
			color: "var(--dsw-alias-label-secondary)",
			cursor: "pointer"
		};

		/** 输入框右侧座位里的按钮图标：屏幕 + 十字准星。 */
		function IconScreen() {
			return h("svg", {
				viewBox: "0 0 16 16",
				width: "15",
				height: "15",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.3,
				"aria-hidden": true
			}, [
				h("rect", { key: "screen", x: 1.6, y: 2.6, width: 12.8, height: 8.6, rx: 1.2 }),
				h("path", { key: "stand", d: "M6 14h4M8 11.2V14" }),
				h("path", { key: "cross", d: "M8 5.2v3.4M6.3 6.9h3.4" })
			]);
		}

		/** 输入框右侧座位里的截图按钮。 */
		function CaptureButton() {
			const [busy, setBusy] = useState(false);
			const [toast, setToast] = useState(null);
			const toastTimer = useRef(0);
			// 只看"本次挂载之后"产生的结果，避免页面刷新时把上一次的提示又弹一遍。
			const seenOutcome = useRef(Date.now());
			// 本轮结论是否已经处理过：拿到结论就停止轮询，别空转打 /status。
			const settled = useRef(false);

			const showToast = useCallback((text, error) => {
				setToast({ text, error });
				window.clearTimeout(toastTimer.current);
				toastTimer.current = window.setTimeout(() => setToast(null), 3600);
			}, []);

			useEffect(() => () => window.clearTimeout(toastTimer.current), []);

			/**
			 * 轮询宿主结果并**自动投递**。
			 * 四种收尾：captured / cancelled / timeout / failed。
			 * 为什么是轮询而不是只听焦点事件：兜底路径下宿主会提前把 DSH 窗口还原（遮罩仍盖在上面），
			 * 那时焦点事件就烧掉了，等用户真正选完反而收不到通知。所以点完按钮就开始按 POLL_MS 问，
			 * 直到拿到结论为止——窗口最小化时定时器会被节流，但节流后的 1s 粒度也够用。
			 * 拿到结论后**停止轮询**：空转打 `/status` 既没必要，也掩盖了"没拿到结论"这种异常。
			 */
			useEffect(() => {
				let alive = true;
				let timer = 0;
				const finish = async () => {
					const { body } = await postJson(STATUS_ROUTE);
					if (!alive || body?.ok !== true) return false;
					const value = body.value;
					if (!value?.outcome || !(value.finishedAt > seenOutcome.current)) return false;
					seenOutcome.current = value.finishedAt;
					settled.current = true;
					const t = strings();
					if (value.outcome === "captured") {
						try {
							await waitForPaint();
							const result = await deliverCrop();
							trace(`delivered crop ${result.size}B into the composer via ${result.channel} (verified=${result.verified})`);
							showToast(t.delivered, false);
						} catch (error) {
							trace(`auto-insert failed: ${error?.message ?? error}`);
							showToast(t.clipboardOnly, true);
						}
					} else if (value.outcome === "cancelled") showToast(t.cancelled, false);
					else if (value.outcome === "timeout") showToast(t.timedOut, true);
					else if (value.outcome === "failed") showToast(t.toolFailed, true);
					else if (value.outcome === "unloaded") showToast(t.reloaded, true);
					trace(`status: ${value.outcome}`);
					return true;
				};
				const tick = async () => {
					if (!alive) return;
					let settledNow = false;
					try {
						settledNow = await finish();
					} catch {
						/* 状态查询失败不值得打扰用户 */
					}
					if (!alive) return;
					if (settledNow || settled.current) return; // 结论已定，不再空转
					timer = window.setTimeout(tick, POLL_MS);
				};
				// 挂载后问一次：兼容"页面刷新后宿主已有结论"的情况；之后靠 kick 连轮询。
				timer = window.setTimeout(tick, POLL_MS);
				const kick = () => {
					if (!alive || settled.current) return;
					window.clearTimeout(timer);
					timer = window.setTimeout(tick, 80);
				};
				window.addEventListener("focus", kick);
				document.addEventListener("visibilitychange", kick);
				return () => {
					alive = false;
					window.clearTimeout(timer);
					window.removeEventListener("focus", kick);
					document.removeEventListener("visibilitychange", kick);
				};
			}, [showToast]);

			const start = useCallback(async () => {
				if (busy) return;
				setBusy(true);
				try {
					const { body } = await postJson(MINIMIZE_ROUTE);
					if (body?.ok !== true) throw new Error(body?.error?.message ?? "request failed");
					if (body.value?.alreadyArmed === true) {
						// 真的在截图：**必须**让用户看到反馈，静默返回会变成"点了没反应"。
						trace("minimize ignored: a capture is already armed");
						showToast(t.alreadyArmed, false);
						settled.current = false; // 上一轮的结论不算数，继续等这一轮
						return;
					}
					settled.current = false;
					trace(`minimize ok hwnd=${body.value?.hwnd}`);
				} catch (error) {
					const t = strings();
					const message = String(error?.message ?? error);
					trace(`minimize failed: ${message}`);
					if (message.includes("window-not-found")) showToast(t.noWindow, true);
					else if (message.includes("did not minimize")) showToast(t.noMinimize, true);
					else showToast(t.failed + message, true);
				} finally {
					setBusy(false);
				}
			}, [busy, showToast]);

			return h(react.Fragment, null, [
				h("button", {
					key: "button",
					type: "button",
					title: strings().tooltip,
					"aria-label": strings().button,
					"data-dsh-shot-button": "1",
					disabled: busy,
					onClick: start,
					style: { ...buttonStyle, opacity: busy ? 0.5 : 1, cursor: busy ? "default" : "pointer" }
				}, h(IconScreen)),
				toast
					? h("div", {
						key: "toast",
						style: {
							position: "fixed",
							left: "50%",
							bottom: 80,
							transform: "translateX(-50%)",
							maxWidth: "70vw",
							padding: "6px 14px",
							borderRadius: 8,
							fontSize: 13,
							lineHeight: "20px",
							zIndex: Z_TOAST,
							pointerEvents: "none",
							whiteSpace: "nowrap",
							overflow: "hidden",
							textOverflow: "ellipsis",
							background: "var(--dsw-alias-interactive-bg-hover-solid)",
							color: toast.error ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-label-primary)"
						}
					}, toast.text)
					: null
			]);
		}

		const inject = ["slots"];

		/**
		 * 只做一件事：输入框右侧座位放截图按钮。
		 *
		 * **故意不再注册 `conversation.input.attachments`**。那个槽位是 `kind: "single"`，
		 * 已被官方附件组件以 priority 0 占用；同优先级注册会被登记表拒绝（桥装不上，
		 * 早期版本因此一直静默走 file input 兜底），而改优先级去抢会把官方的
		 * 草稿缩略图与拖放区顶掉——为一个 `onAddFiles` 引用不值得。
		 * 投递改走 composer 自己的 file input，见 `submitViaFileInput`。
		 */
		function apply(ctx) {
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "dsh-desktop-shot",
				order: -20
			}, CaptureButton));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
