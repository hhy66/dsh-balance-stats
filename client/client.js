/**
 * dsh-balance-stats — browser half (lazy-CJS 客户端 bundle, v0.2.0)。
 *
 * 在 DSH 设置页注册「余额与消耗」区块 (settings.section 槽位):
 *   - 余额: 单例轮询器每 30s 读取 /balance-stats/stats(只读缓存, 不直接访问 DeepSeek);
 *     点击「刷新」按钮穿透缓存向 /balance-stats/query 发起强刷。
 *   - 消耗: 本机全部会话的 token 汇总与【计算步骤明细】——
 *     按事件发生时刻的官方峰谷时段, 逐条展示 未命中输入/缓存写入/缓存命中/输出 × 单价 = 花费。
 *   - 官方定价: 展示官方价格表、峰谷规则与扣费规则原文, 附官方页面链接供对账。
 */
window.__ModuleLoader__.load({
	id: "dsh-balance-stats",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		//#region styles
		const CSS_ID = "dsh-balance-stats/styles.css";
		if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-balance-stats";
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = [
				".dbs_root{display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary,#1f2328)}",
				".dbs_card{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,0.06));border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,0.15));border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:8px}",
				".dbs_card_title{display:flex;align-items:center;justify-content:space-between;font-weight:600;font-size:13px;color:var(--dsw-alias-label-secondary,#57606a)}",
				".dbs_row{display:flex;align-items:baseline;justify-content:space-between;gap:12px}",
				".dbs_label{color:var(--dsw-alias-label-tertiary,#8b949e);font-size:12px}",
				".dbs_value{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#1f2328)}",
				".dbs_big{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#1f2328);display:flex;align-items:center;gap:8px}",
				".dbs_dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0}",
				".dbs_dot_green{background:var(--dsw-alias-state-success-primary,#10b981);box-shadow:0 0 0 2px rgba(16,185,129,0.2)}",
				".dbs_dot_yellow{background:var(--dsw-alias-state-warn-primary,#f59e0b);box-shadow:0 0 0 2px rgba(245,158,11,0.2)}",
				".dbs_dot_red{background:var(--dsw-alias-state-error-primary,#ef4444);box-shadow:0 0 0 2px rgba(239,68,68,0.2)}",
				".dbs_dot_gray{background:var(--dsw-alias-border-secondary,rgba(128,128,128,0.5))}",
				".dbs_btn{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.25));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-secondary,#57606a);border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer;line-height:1.5}",
				".dbs_btn:hover{color:var(--dsw-alias-label-primary,#1f2328);background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.1))}",
				".dbs_btn:disabled{opacity:.55;cursor:default}",
				".dbs_spin{animation:dbs-rotate 0.8s linear infinite;display:inline-block}",
				"@keyframes dbs-rotate{to{transform:rotate(360deg)}}",
				".dbs_muted{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8b949e)}",
				".dbs_error{color:var(--dsw-alias-state-error-primary,#ef4444);font-size:12px}",
				".dbs_table{width:100%;border-collapse:collapse;font-size:12px}",
				".dbs_table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-tertiary,#8b949e);padding:3px 0;border-bottom:1px solid var(--dsw-alias-separator-primary,rgba(128,128,128,0.15))}",
				".dbs_table td{padding:3px 0;font-variant-numeric:tabular-nums;border-bottom:1px solid var(--dsw-alias-separator-primary,rgba(128,128,128,0.08))}",
				".dbs_table tr:last-child td{border-bottom:none}",
				".dbs_table td.num{text-align:right}",
				".dbs_formula{font-family:var(--dsw-alias-font-mono,ui-monospace,Consolas,monospace);font-size:11.5px;color:var(--dsw-alias-label-secondary,#57606a);background:var(--dsw-alias-bg-layer-3,rgba(128,128,128,0.04));border-radius:6px;padding:8px 10px;white-space:pre-wrap}",
				".dbs_model_head{display:flex;align-items:baseline;justify-content:space-between;font-weight:600;font-size:12.5px;color:var(--dsw-alias-label-secondary,#57606a);padding-top:4px}",
				".dbs_tier_tag{display:inline-block;font-size:11px;font-weight:500;border-radius:4px;padding:1px 6px;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.1));color:var(--dsw-alias-label-secondary,#57606a);margin-right:6px}",
				".dbs_step{display:flex;align-items:baseline;justify-content:space-between;gap:10px;font-size:12px;font-family:var(--dsw-alias-font-mono,ui-monospace,Consolas,monospace);color:var(--dsw-alias-label-secondary,#57606a);padding:1px 0 1px 8px}",
				".dbs_step_total{font-weight:600;color:var(--dsw-alias-label-primary,#1f2328)}",
				".dbs_link{color:var(--dsw-alias-brand-primary,#3b82f6);text-decoration:none}",
				".dbs_link:hover{text-decoration:underline}",
				".dbs_sessions{display:flex;flex-direction:column;gap:4px;max-height:280px;overflow:auto}",
				".dbs_sess_row{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;padding:4px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-3,rgba(128,128,128,0.04))}",
				".dbs_sess_col{display:flex;flex-direction:column;min-width:0;flex:1;gap:1px}",
				".dbs_sess_title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#57606a)}",
				".dbs_sess_ws{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8b949e)}",
				".dbs_filter_bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}",
				".dbs_select,.dbs_input{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.25));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,#1f2328);border-radius:6px;padding:3px 8px;font-size:12px;line-height:1.5;max-width:100%}",
				".dbs_input{min-width:150px;flex:1}",
				".dbs_select:focus,.dbs_input:focus{outline:1px solid var(--dsw-alias-brand-primary,#3b82f6)}",
				".dbs_model_head{cursor:pointer;user-select:none}",
				".dbs_filter_sum{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8b949e)}",
				".dbs_hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b949e);border-top:1px dashed var(--dsw-alias-separator-primary,rgba(128,128,128,0.15));padding-top:6px}",
				".dbs_head{display:flex;align-items:center;justify-content:space-between;gap:8px}",
				".dbs_head_side{display:flex;align-items:center;gap:8px}",
				".dbs_kpi{display:flex;flex-wrap:wrap;gap:10px}",
				".dbs_kpi_cell{flex:1;min-width:130px;display:flex;flex-direction:column;gap:2px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,0.06));border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,0.15));border-radius:10px;padding:10px 14px}",
				".dbs_kpi_label{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8b949e)}",
				".dbs_kpi_value{font-size:19px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#1f2328);display:flex;align-items:center}",
				".dbs_bar_track{height:8px;border-radius:4px;background:var(--dsw-alias-bg-layer-3,rgba(128,128,128,0.12));overflow:hidden}",
				".dbs_bar_fill{height:100%;border-radius:4px;background:var(--dsw-alias-state-success-primary,#10b981);transition:width .3s ease}",
				".dbs_bar_warn{background:var(--dsw-alias-state-warn-primary,#f59e0b)}",
				".dbs_bar_over{background:var(--dsw-alias-state-error-primary,#ef4444)}",
				".dbs_foot{display:flex;align-items:center;gap:5px;font-size:13px;color:var(--dsw-alias-label-secondary,#57606a);padding:5px 8px;border-radius:6px;overflow:hidden;white-space:nowrap;min-width:0}",
				".dbs_foot:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.1))}",
				".dbs_foot_val{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#1f2328);font-weight:600}",
				".dbs_foot_sep{color:var(--dsw-alias-separator-primary,rgba(128,128,128,0.3));margin:0 1px;flex-shrink:0}",
				".dbs_foot_lab{color:var(--dsw-alias-label-tertiary,#8b949e)}",
				".dbs_foot_rail{justify-content:center;padding:5px 0}",
				".dbs_foot .dbs_dot{width:10px;height:10px}"
			].join("");
			document.head.appendChild(tag);
		}
		//#endregion

		const fmtTokens = (n) => {
			if (!Number.isFinite(n) || n <= 0) return "0";
			if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
			if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
			return String(n);
		};
		const fmtMoney = (n) => {
			if (!Number.isFinite(n)) return "0";
			if (n > 0 && n < 0.01) return n.toFixed(4);
			return n.toFixed(2);
		};
		const fmtDate = (ts) => {
			if (!ts) return "—";
			const d = new Date(ts);
			if (Number.isNaN(d.getTime())) return "—";
			const pad = (x) => String(x).padStart(2, "0");
			return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
		};
		const shortId = (id) => (typeof id === "string" && id.length > 8 ? id.slice(0, 8) : id ?? "—");
		const TIER_LABEL = { legacy: "旧价格(8-17前)", offpeak: "空闲时段", peak: "高峰时段" };

		/** 本地日历日 key: YYYY-MM-DD(与宿主端一致, 用于逐日数据切片) */
		const dayKeyOfTs = (ts) => {
			const d = new Date(ts);
			const pad = (n) => String(n).padStart(2, "0");
			return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
		};

		/** 时段切片: 汇总逐日数组中 [fromKey, toKey] 闭区间内的花费与 token(含端点)。 */
		const sumPeriod = (daysArr, fromKey, toKey) => {
			const tokens = { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
			let cost = 0;
			if (!Array.isArray(daysArr)) return { cost, tokens };
			for (const d of daysArr) {
				if (fromKey !== null && d.day < fromKey) continue;
				if (toKey !== null && d.day > toKey) continue;
				cost += d.cost ?? 0;
				tokens.uncachedInput += d.tokens?.uncachedInput ?? 0;
				tokens.cacheRead += d.tokens?.cacheRead ?? 0;
				tokens.cacheWrite += d.tokens?.cacheWrite ?? 0;
				tokens.output += d.tokens?.output ?? 0;
			}
			return { cost, tokens };
		};

		/** 余额状态: { cls, text } */
		const balanceStatus = (balance) => {
			if (!balance || !balance.ok || !Array.isArray(balance.balances) || balance.balances.length === 0) {
				return { cls: "dbs_dot_gray", text: "未获取到余额" };
			}
			const total = balance.balances.reduce((s, b) => s + (Number(b.total) || 0), 0);
			const t = balance.thresholds ?? {};
			if (typeof t.danger === "number" && total < t.danger) return { cls: "dbs_dot_red", text: "余额告急" };
			if (typeof t.warning === "number" && total < t.warning) return { cls: "dbs_dot_yellow", text: "余额偏低" };
			return { cls: "dbs_dot_green", text: "余额充足" };
		};

		/** 一条计算步骤: 名称 × 单价 = 金额(元), 单价为每百万 token */
		const StepLine = ({ label, tokens, price, sign }) => react.createElement("div", { className: "dbs_step" },
			react.createElement("span", null,
				label + "  " + fmtTokens(tokens) + " × ¥" + price + "/M",
				sign === "+" && react.createElement("span", { className: "dbs_muted" }, "  =  ¥" + fmtMoney(tokens * price / 1e6))
			),
			react.createElement("span", null, sign + " ¥" + fmtMoney(tokens * price / 1e6))
		);

		// ── 共享 KPI 数据仓库: 设置面板与侧边栏页脚共用同一份数据与轮询 ──
		// 30 秒轮询 + 页面可见性恢复 + 会话推送流触发的防抖刷新。
		const kpiStore = {
			data: null,
			error: null,
			listeners: new Set(),
			timer: null,
			load: async () => {
				try {
					const res = await fetch("/balance-stats/stats", { cache: "no-store" });
					if (!res.ok) throw new Error("HTTP " + res.status);
					kpiStore.data = await res.json();
					kpiStore.error = null;
				} catch (err) {
					kpiStore.error = err instanceof Error ? err.message : String(err);
				}
				for (const fn of kpiStore.listeners) {
					try { fn() } catch { /* 监听器异常隔离 */ }
				}
			},
			ensureLoop: () => {
				if (kpiStore.timer !== null) return;
				kpiStore.load();
				kpiStore.timer = setInterval(() => { kpiStore.load() }, 30000);
				const onVisible = () => {
					if (!document.hidden) kpiStore.load();
				};
				document.addEventListener("visibilitychange", onVisible);
				kpiStore.offVisible = onVisible;
			},
			subscribe: (fn) => {
				kpiStore.listeners.add(fn);
				kpiStore.ensureLoop();
				return () => {
					kpiStore.listeners.delete(fn);
				};
			},
			getSnapshot: () => kpiStore.data,
			getError: () => kpiStore.error,
		};

		const useKpi = () => react.useSyncExternalStore(kpiStore.subscribe, kpiStore.getSnapshot, kpiStore.getSnapshot);
		const useKpiError = () => react.useSyncExternalStore(kpiStore.subscribe, kpiStore.getError, kpiStore.getError);

		/** 从 /stats 数据派生 KPI 核心值(设置面板与侧边栏页脚共用)。 */
		const kpiOf = (data) => {
			const balance = data?.balance ?? null;
			const totals = data?.totals ?? null;
			const days = Array.isArray(totals?.days) ? totals.days : [];
			const pad = (n) => String(n).padStart(2, "0");
			const d = new Date();
			const todayKey = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
			const monthKey = todayKey.slice(0, 7);
			const todayCost = days.find((x) => x.day === todayKey)?.cost ?? 0;
			const monthCost = days.reduce((s, x) => (x.day.startsWith(monthKey) ? s + x.cost : s), 0);
			const recent7 = days.slice(-7);
			const dailyAvg = recent7.length > 0 ? recent7.reduce((s, x) => s + x.cost, 0) / recent7.length : 0;
			const totalBalance = (balance?.balances ?? []).reduce((s, b) => s + (Number(b.total) || 0), 0);
			const daysLeft = dailyAvg > 0 && balance?.ok ? totalBalance / dailyAvg : null;
			const currency = balance?.currency ?? "CNY";
			const money = (n) => (currency === "CNY" ? "¥" : currency + " ") + fmtMoney(n);
			return { balance, totalBalance, todayCost, monthCost, daysLeft, money };
		};

		/** 左侧边栏页脚 KPI 盘头(官方 sidebar.footer.action 插槽, 位于设置行上方)。 */
		function KpiFooter({ wide }) {
			const data = useKpi();
			const kpi = kpiOf(data);
			const dotCls = balanceStatus(kpi.balance).cls;
			const left = kpi.daysLeft === null ? "—" : (kpi.daysLeft >= 365 ? ">1年" : "≈" + (kpi.daysLeft < 1 ? kpi.daysLeft.toFixed(1) : String(Math.round(kpi.daysLeft))) + "天");
			if (!wide) {
				// 侧边栏收起(窄轨): 只显示状态灯
				return react.createElement("div", {
					className: "dbs_foot dbs_foot_rail",
					title: "余额 " + kpi.money(kpi.totalBalance) + " · 续航 " + left + " · 今日 " + kpi.money(kpi.todayCost) + " · 本月 " + kpi.money(kpi.monthCost)
				}, react.createElement("span", { className: "dbs_dot " + dotCls }));
			}
			return react.createElement("div", {
				className: "dbs_foot",
				title: "DeepSeek 余额与消耗 · 30 秒自动更新"
			},
				react.createElement("span", { className: "dbs_dot " + dotCls }),
				react.createElement("span", { className: "dbs_foot_val" }, kpi.money(kpi.totalBalance)),
				react.createElement("span", { className: "dbs_foot_sep" }, "·"),
				react.createElement("span", { className: "dbs_foot_val" }, left),
				react.createElement("span", { className: "dbs_foot_sep" }, "·"),
				react.createElement("span", { className: "dbs_foot_lab" }, "今"),
				react.createElement("span", { className: "dbs_foot_val" }, kpi.money(kpi.todayCost)),
				react.createElement("span", { className: "dbs_foot_sep" }, "·"),
				react.createElement("span", { className: "dbs_foot_lab" }, "月"),
				react.createElement("span", { className: "dbs_foot_val" }, kpi.money(kpi.monthCost))
			);
		}

		function BalanceStatsSection({ sessionsFeed }) {
			const data = useKpi();
			const error = useKpiError();
			const [, setTick] = react.useState(0);
			const loadDebounce = react.useRef(null);
			const [refreshing, setRefreshing] = react.useState(false);
			const [wsFilter, setWsFilter] = react.useState("");
			const [timeFilter, setTimeFilter] = react.useState("all");
			const [search, setSearch] = react.useState("");
			const [collapsed, setCollapsed] = react.useState({});

			// ── 会话热重载: 订阅 Web 界面的会话列表推送流 ──
			// 改名/新标题(标题投影帧)、会话增删都会触发; 标题立即从推送条目中读取,
			// 统计数字做 800ms 防抖刷新, 避免模型连续输出时高频请求。
			react.useEffect(() => {
				let off = null;
				try {
					off = sessionsFeed?.subscribe?.(() => {
						setTick((t) => t + 1);
						if (loadDebounce.current !== null) clearTimeout(loadDebounce.current);
						loadDebounce.current = setTimeout(() => {
							loadDebounce.current = null;
							kpiStore.load();
						}, 800);
					});
				} catch {
					/* 订阅不可用时回退到 30s 轮询 */
				}
				return () => {
					if (loadDebounce.current !== null) clearTimeout(loadDebounce.current);
					if (off) {
						try { off(); } catch { /* 已释放 */ }
					}
				};
			}, [sessionsFeed]);

			const doRefresh = react.useCallback(async () => {
				setRefreshing(true);
				try {
					await fetch("/balance-stats/query?force=1", { method: "POST" });
				} catch {
					/* 强刷失败仍展示缓存 */
				}
				await kpiStore.load();
				setRefreshing(false);
			}, []);

			const balance = data?.balance ?? null;
			const totals = data?.totals ?? null;
			const breakdown = Array.isArray(data?.breakdown) ? data.breakdown : [];
			const pricing = data?.pricing ?? null;
			const coldData = data?.cold ?? null;
			const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
			const status = balanceStatus(balance);
			const balances = balance?.balances ?? [];
			const currency = balance?.currency ?? "CNY";
			const inputTotal = totals ? (totals.tokens.uncachedInput + totals.tokens.cacheRead + totals.tokens.cacheWrite) : 0;
			const moneyOf = (n) => (currency === "CNY" ? "¥" : currency + " ") + fmtMoney(n);

			// ── Web 界面的会话列表条目(标题/工作区/投影值, 随推送帧实时更新) ──
			const entryById = new Map();
			try {
				const snap = sessionsFeed?.getListSnapshot?.();
				for (const it of snap?.items ?? []) entryById.set(it.sessionId, it);
			} catch { /* 读取失败时退回宿主数据 */ }

			// ── 会话筛选(纯前端, 数据已由宿主汇总) ──
			// 时间边界(本地时区): 今天 / 昨天 / 本周(周一起) / 本月 / 全部
			const nowD = new Date();
			const dayStartToday = new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate()).getTime();
			const dayStartYesterday = dayStartToday - 86400e3;
			const weekStart = dayStartToday - ((nowD.getDay() + 6) % 7) * 86400e3;
			const monthStart = new Date(nowD.getFullYear(), nowD.getMonth(), 1).getTime();
			// ── 时段切片范围(ISO 日期键): 时间筛选激活时, 行数据与汇总都切换为时段内消耗 ──
			const keyToday = dayKeyOfTs(Date.now());
			const keyYesterday = dayKeyOfTs(Date.now() - 86400e3);
			const keyWeekStart = dayKeyOfTs(weekStart);
			const keyMonthStart = keyToday.slice(0, 7) + "-01";
			const periodRange = timeFilter === "all" ? null
				: timeFilter === "today" ? { from: keyToday, to: keyToday }
				: timeFilter === "yesterday" ? { from: keyYesterday, to: keyYesterday }
				: timeFilter === "week" ? { from: keyWeekStart, to: keyToday }
				: timeFilter === "month" ? { from: keyMonthStart, to: keyToday }
				: null;
			const workspaces = [...new Set(sessions.map((s) => s.workspace).filter((w) => typeof w === "string" && w !== ""))].sort();
			const filtered = sessions.filter((s) => {
				if (wsFilter !== "" && s.workspace !== wsFilter) return false;
				if (timeFilter !== "all") {
					// 时间戳优先取 Web 界面实时推送的 updatedAt, 其次宿主折叠的 updated/created
					const t = entryById.get(s.id)?.updatedAt ?? s.updated ?? s.created;
					if (!t) return false;
					if (timeFilter === "today") {
						if (t < dayStartToday) return false;
					} else if (timeFilter === "yesterday") {
						if (t < dayStartYesterday || t >= dayStartToday) return false;
					} else if (timeFilter === "week") {
						if (t < weekStart) return false;
					} else if (timeFilter === "month") {
						if (t < monthStart) return false;
					}
				}
				if (search.trim() !== "") {
					const q = search.trim().toLowerCase();
					const liveTitle = entryById.get(s.id)?.title ?? "";
					const hay = (liveTitle + " " + String(s.title ?? "") + " " + String(s.id ?? "")).toLowerCase();
					if (!hay.includes(q)) return false;
				}
				return true;
			});
			const filteredSum = filtered.reduce((acc, s) => {
				// 时间筛选激活: 汇总的是各会话在时段内的消耗(切片), 非累计总额
				const period = periodRange !== null ? sumPeriod(s.days, periodRange.from, periodRange.to) : null;
				const tk = period !== null ? period.tokens : s.tokens;
				const c = period !== null ? period.cost : s.cost;
				acc.uncachedInput += tk.uncachedInput;
				acc.cacheRead += tk.cacheRead;
				acc.cacheWrite += tk.cacheWrite;
				acc.output += tk.output;
				acc.cost += c;
				return acc;
			}, { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0 });
			const toggleModel = (model) => setCollapsed((prev) => {
				const next = { ...prev };
				next[model] = !next[model];
				return next;
			});

			// ── KPI 派生值(今日 / 本月 / 续航 / 预算 / 命中率) ──
			const days = Array.isArray(totals?.days) ? totals.days : [];
			const pad2 = (n) => String(n).padStart(2, "0");
			const nowDate = new Date();
			const todayKey = nowDate.getFullYear() + "-" + pad2(nowDate.getMonth() + 1) + "-" + pad2(nowDate.getDate());
			const monthKey = todayKey.slice(0, 7);
			const todayCost = days.find((d) => d.day === todayKey)?.cost ?? 0;
			const monthCost = days.reduce((s, d) => (d.day.startsWith(monthKey) ? s + d.cost : s), 0);
			const recent7 = days.slice(-7);
			const dailyAvg = recent7.length > 0 ? recent7.reduce((s, d) => s + d.cost, 0) / recent7.length : 0;
			const totalBalance = (balance?.balances ?? []).reduce((s, b) => s + (Number(b.total) || 0), 0);
			const daysLeft = dailyAvg > 0 && balance?.ok ? totalBalance / dailyAvg : null;
			const budget = data?.budget ?? null;
			const budgetOn = budget !== null && Number(budget.daily) > 0;
			const budgetPct = budgetOn ? Math.min(1, todayCost / budget.daily) : 0;
			const hitRateOf = (b) => {
				const denom = (b?.uncachedInput ?? 0) + (b?.cacheRead ?? 0) + (b?.cacheWrite ?? 0);
				return denom > 0 ? (b?.cacheRead ?? 0) / denom : null;
			};
			const globalHit = totals !== null ? hitRateOf(totals.tokens) : null;
			const wsAgg = new Map();
			for (const s of sessions) {
				const ws = s.workspace || "未知工作区";
				const cur = wsAgg.get(ws) ?? { uncachedInput: 0, cacheRead: 0, cacheWrite: 0 };
				cur.uncachedInput += s.tokens.uncachedInput;
				cur.cacheRead += s.tokens.cacheRead;
				cur.cacheWrite += s.tokens.cacheWrite;
				wsAgg.set(ws, cur);
			}
			const unhealthyWs = [...wsAgg.entries()]
				.map(([ws, b]) => ({ ws, hit: hitRateOf(b), tokens: b.uncachedInput + b.cacheRead + b.cacheWrite }))
				.filter((x) => x.hit !== null && x.hit < 0.5 && x.tokens >= 10000)
				.sort((a, b) => a.hit - b.hit);
			const globalUnhealthy = globalHit !== null && globalHit < 0.5;

			return react.createElement("div", { className: "dbs_root" },
				// ── 标题行
				react.createElement("div", { className: "dbs_head" },
					react.createElement("span", null, "余额与消耗"),
					react.createElement("span", { className: "dbs_head_side" },
						react.createElement("span", { className: "dbs_muted" },
							data && balance?.fetchedAt ? "余额更新于 " + fmtDate(balance.fetchedAt) : ""
						),
						react.createElement("button", {
							type: "button",
							className: "dbs_btn",
							disabled: refreshing,
							onClick: doRefresh
						}, refreshing ? react.createElement("span", { className: "dbs_spin" }, "⟳") : "⟳ 刷新余额")
					)
				),
				error !== null && react.createElement("div", { className: "dbs_error" }, "读取统计失败: " + error),
				// ── KPI 仪表盘头 ──
				react.createElement("div", { className: "dbs_kpi" },
					react.createElement("div", { className: "dbs_kpi_cell" },
						react.createElement("span", { className: "dbs_kpi_label" }, "余额"),
						react.createElement("span", { className: "dbs_kpi_value" },
							react.createElement("span", { className: "dbs_dot " + status.cls, style: { marginRight: "6px" } }),
							totalBalance > 0 ? "¥" + totalBalance.toFixed(2) : "—"
						)
					),
					react.createElement("div", { className: "dbs_kpi_cell" },
						react.createElement("span", { className: "dbs_kpi_label" }, "续航"),
						react.createElement("span", { className: "dbs_kpi_value" },
							daysLeft === null ? "—" : (daysLeft >= 365 ? "> 1 年" : "≈ " + (daysLeft < 1 ? daysLeft.toFixed(1) : String(Math.round(daysLeft))) + " 天")
						)
					),
					react.createElement("div", { className: "dbs_kpi_cell" },
						react.createElement("span", { className: "dbs_kpi_label" }, "今日" + (budgetOn ? "（预算 " + moneyOf(budget.daily) + "）" : "")),
						react.createElement("span", { className: "dbs_kpi_value" }, moneyOf(todayCost)),
						budgetOn && react.createElement("div", { className: "dbs_bar_track", style: { marginTop: "4px" } },
							react.createElement("div", {
								className: "dbs_bar_fill" + (budgetPct >= 1 ? " dbs_bar_over" : budgetPct >= 0.8 ? " dbs_bar_warn" : ""),
								style: { width: Math.min(100, (todayCost / budget.daily) * 100) + "%" }
							})
						),
						budgetOn && todayCost >= budget.daily && react.createElement("span", { className: "dbs_muted", style: { color: "var(--dsw-alias-state-error-primary,#ef4444)" } },
							"已超 " + moneyOf(todayCost - budget.daily)
						),
						budgetOn && todayCost < budget.daily && todayCost / budget.daily >= 0.8 && react.createElement("span", { className: "dbs_muted", style: { color: "var(--dsw-alias-state-warn-primary,#f59e0b)" } },
							"已用 " + Math.round((todayCost / budget.daily) * 100) + "%"
						)
					),
					react.createElement("div", { className: "dbs_kpi_cell" },
						react.createElement("span", { className: "dbs_kpi_label" }, "本月"),
						react.createElement("span", { className: "dbs_kpi_value" }, moneyOf(monthCost))
					)
				),
				// ── 余额卡(默认收缩, 详情在 KPI 头) ──
				react.createElement("details", { className: "dbs_card" },
					react.createElement("summary", { className: "dbs_card_title", style: { cursor: "pointer" } },
						react.createElement("span", null, "💰 账户余额"),
						react.createElement("span", { className: "dbs_muted", style: { display: "inline-flex", alignItems: "center", gap: "6px" } },
							react.createElement("span", { className: "dbs_dot " + status.cls }),
							status.text
						)
					),
					balances.length > 0
						? balances.map((b, i) => react.createElement("div", { key: i, className: "dbs_big" },
							(b.currency ?? "CNY") === "CNY" ? "¥" : (b.currency ?? ""),
							Number(b.total).toFixed(2),
							!balance.isAvailable && react.createElement("span", { className: "dbs_muted", style: { fontSize: "12px", fontWeight: 400 } }, "(账户不可用)")
						))
						: react.createElement("div", { className: "dbs_big" },
							"—",
							react.createElement("span", { className: "dbs_muted", style: { fontSize: "12px", fontWeight: 400 } },
								balance?.error === "api-key-missing" ? "未配置 DEEPSEEK_API_KEY 密钥" : (balance?.error ?? "暂无数据")
							)
						),
					balances.length > 0 && react.createElement("div", { className: "dbs_row" },
						react.createElement("span", { className: "dbs_label" }, "充值余额"),
						react.createElement("span", { className: "dbs_value" }, (balances[0].currency ?? "CNY") === "CNY" ? "¥" + Number(balances[0].toppedUp).toFixed(2) : Number(balances[0].toppedUp).toFixed(2) + " " + (balances[0].currency ?? ""))
					),
					balances.length > 0 && react.createElement("div", { className: "dbs_row" },
						react.createElement("span", { className: "dbs_label" }, "赠送余额"),
						react.createElement("span", { className: "dbs_value" }, (balances[0].currency ?? "CNY") === "CNY" ? "¥" + Number(balances[0].granted).toFixed(2) : Number(balances[0].granted).toFixed(2) + " " + (balances[0].currency ?? ""))
					),
					react.createElement("div", { className: "dbs_hint" },
						"余额来自官方接口 ",
						react.createElement("a", { className: "dbs_link", href: pricing?.balanceApiUrl ?? "https://api-docs.deepseek.com/api/get-user-balance", target: "_blank", rel: "noreferrer" }, "GET /user/balance"),
						"，每 " + Math.max(1, Math.round((balance?.refreshIntervalMs ?? 300000) / 60000)) + " 分钟自动更新。"
					)
				),
				// ── 消耗汇总卡(默认收缩) ──
				totals !== null && react.createElement("details", { className: "dbs_card" },
					react.createElement("summary", { className: "dbs_card_title", style: { cursor: "pointer" } },
						react.createElement("span", null, "📊 本机全部会话消耗"),
						react.createElement("span", { className: "dbs_muted" }, "共 " + totals.sessionCount + " 个会话 · " + (totals.workspaceCount ?? 0) + " 个工作区")
					),
					react.createElement("div", { className: "dbs_row" },
						react.createElement("span", { className: "dbs_label" }, "输入 tokens（合计）"),
						react.createElement("span", { className: "dbs_value" }, fmtTokens(inputTotal))
					),
					react.createElement("div", { className: "dbs_row" },
						react.createElement("span", { className: "dbs_label" }, "　其中缓存命中"),
						react.createElement("span", { className: "dbs_value" }, fmtTokens(totals.tokens.cacheRead))
					),
					globalHit !== null && react.createElement("div", { className: "dbs_row" },
						react.createElement("span", { className: "dbs_label" }, "缓存命中率"),
						react.createElement("span", {
							className: "dbs_value",
							style: { color: globalHit >= 0.7 ? "var(--dsw-alias-state-success-primary,#10b981)" : globalHit >= 0.5 ? "inherit" : "var(--dsw-alias-state-warn-primary,#f59e0b)" }
						}, Math.round(globalHit * 100) + "%")
					),
					react.createElement("div", { className: "dbs_row" },
						react.createElement("span", { className: "dbs_label" }, "输出 tokens"),
						react.createElement("span", { className: "dbs_value" }, fmtTokens(totals.tokens.output))
					),
					react.createElement("div", { className: "dbs_row" },
						react.createElement("span", { className: "dbs_label" }, "预估花费（合计）"),
						react.createElement("span", { className: "dbs_value", style: { fontWeight: 600 } }, moneyOf(totals.cost))
					),
					((totals.aux?.titles ?? 0) > 0 || (totals.aux?.searches ?? 0) > 0) && react.createElement("div", { className: "dbs_muted" },
						"另有辅助调用未计入（其用量不写入本地日志，官方账单仍计费）：标题生成 " + (totals.aux?.titles ?? 0) + " 次 · 网页搜索 " + (totals.aux?.searches ?? 0) + " 次 —— 与官方账单的差值通常来源于此"
					)
				),
				// ── 缓存命中率健康提示 ──
				(globalUnhealthy || unhealthyWs.length > 0) && react.createElement("div", { className: "dbs_card" },
					react.createElement("div", { className: "dbs_card_title" }, react.createElement("span", null, "🩺 缓存命中率健康提示")),
					globalUnhealthy && react.createElement("div", { className: "dbs_muted" },
						"全局缓存命中率仅 " + Math.round(globalHit * 100) + "%。未命中单价是命中的 20~60 倍（如 pro 空闲期 ¥4.5/M vs ¥0.15/M），低命中率意味着大量重复计费。建议：在同一会话内连续对话以复用上下文缓存，避免反复重发大段资料。"
					),
					unhealthyWs.map((x) => react.createElement("div", { key: x.ws, className: "dbs_muted" },
						"「" + x.ws + "」命中率 " + Math.round(x.hit * 100) + "%（输入 " + fmtTokens(x.tokens) + "）——重复计费风险高，检查是否频繁重发相同上下文。"
					))
				),
				// ── 计算步骤明细卡(整卡与逐模型均可折叠, 默认收缩) ──
				react.createElement("details", { className: "dbs_card" },
					react.createElement("summary", { className: "dbs_card_title", style: { cursor: "pointer" } },
						react.createElement("span", null, "🧮 计算步骤明细（与官方对账）"),
						react.createElement("span", { className: "dbs_muted" }, "点击模型名可展开/收起")
					),
					react.createElement("div", { className: "dbs_formula" },
						"费用 = Σ [ (未命中输入 + 缓存写入) × 未命中价\n       + 缓存命中 × 命中价 + 输出 × 输出价 ] ÷ 1,000,000\n单价单位: 元 / 百万 tokens（官方口径）\n含主请求与压缩摘要(compaction/summary)用量"
					),
					breakdown.length === 0
						? react.createElement("div", { className: "dbs_muted" }, "暂无消耗数据（新会话产生 token 后自动出现）")
						: breakdown.map((group) => {
							const isCollapsed = collapsed[group.model] === true;
							return react.createElement("div", { key: group.model, style: { display: "flex", flexDirection: "column", gap: "4px" } },
								react.createElement("div", {
									className: "dbs_model_head",
									title: "点击展开/收起",
									onClick: () => toggleModel(group.model)
								},
									react.createElement("span", null,
										(isCollapsed ? "▸ " : "▾ ") + group.model + (isCollapsed ? "（" + group.tiers.length + " 个时段）" : "")
									),
									react.createElement("span", null, "小计 " + moneyOf(group.cost))
								),
								!isCollapsed && group.tiers.map((t) => {
									const b = t.buckets;
									const p = t.prices;
									const lines = [];
									if (b.uncachedInput > 0) lines.push({ label: "输入·未命中", tokens: b.uncachedInput, price: p.cacheMiss, sign: "+" });
									if (b.cacheWrite > 0) lines.push({ label: "输入·缓存写入", tokens: b.cacheWrite, price: p.cacheMiss, sign: "+" });
									if (b.cacheRead > 0) lines.push({ label: "输入·缓存命中", tokens: b.cacheRead, price: p.cacheHit, sign: "+" });
									if (b.output > 0) lines.push({ label: "输出", tokens: b.output, price: p.output, sign: "+" });
									return react.createElement("div", { key: group.model + "|" + t.tier },
										react.createElement("div", { className: "dbs_muted", style: { paddingTop: "2px" } },
											react.createElement("span", { className: "dbs_tier_tag" }, TIER_LABEL[t.tier] ?? t.tier),
											"计费 ¥" + fmtMoney(t.cost)
										),
										lines.map((l, i) => react.createElement(StepLine, { key: i, label: l.label, tokens: l.tokens, price: l.price, sign: l.sign }))
									);
								})
							);
						}),
					breakdown.length > 0 && react.createElement("div", { className: "dbs_step dbs_step_total" },
						react.createElement("span", null, "全部合计"),
						react.createElement("span", null, moneyOf(totals?.cost ?? 0))
					),
					react.createElement("div", { className: "dbs_hint" },
						"本结果按官方单价本地计算，请与 ",
						react.createElement("a", { className: "dbs_link", href: pricing?.usageUrl ?? "https://platform.deepseek.com/usage", target: "_blank", rel: "noreferrer" }, "官方用量账单"),
						" 对账；如有偏差，逐行核对上方每一步即可定位。"
					)
				),
				// ── 官方定价与扣费规则卡
				pricing !== null && react.createElement("details", { className: "dbs_card" },
					react.createElement("summary", { className: "dbs_card_title", style: { cursor: "pointer" } }, "📄 官方定价与扣费规则"),
					react.createElement("table", { className: "dbs_table" },
						react.createElement("thead", null,
							react.createElement("tr", null,
								react.createElement("th", null, "模型"),
								react.createElement("th", null, "时段"),
								react.createElement("th", null, "缓存命中"),
								react.createElement("th", null, "缓存未命中"),
								react.createElement("th", null, "输出")
							)
						),
						react.createElement("tbody", null,
							Object.entries(pricing.models ?? {}).flatMap(([model, table]) => [
								["legacy", "旧价格", table.legacy],
								["offpeak", "空闲时段", table.offpeak],
								["peak", "高峰时段", table.peak]
							].map(([tier, label, p]) => react.createElement("tr", { key: model + "|" + tier },
								react.createElement("td", null, model),
								react.createElement("td", null, label),
								react.createElement("td", { className: "num" }, "¥" + p.cacheHit + "/M"),
								react.createElement("td", { className: "num" }, "¥" + p.cacheMiss + "/M"),
								react.createElement("td", { className: "num" }, "¥" + p.output + "/M")
							)))
						)
					),
					react.createElement("div", { className: "dbs_muted" }, pricing.note),
					react.createElement("div", { className: "dbs_muted" }, pricing.billingRule),
					react.createElement("div", { className: "dbs_hint" },
						"来源: ",
						react.createElement("a", { className: "dbs_link", href: pricing.source, target: "_blank", rel: "noreferrer" }, "官方定价页"),
						" · 新价自 2026-08-17 00:00（北京时间）起生效"
					)
				),
				// ── 会话明细(按工作区/时间/关键词筛选)
				sessions.length > 0 && react.createElement("details", { className: "dbs_card" },
					react.createElement("summary", { className: "dbs_card_title", style: { cursor: "pointer" } },
						"📋 最近会话明细（" + sessions.length + "）" + (coldData?.status !== "ready" ? " · 扫描历史会话中…" : "") + (coldData?.count > 0 ? " · 含 " + coldData.count + " 个历史会话" : "")
					),
					react.createElement("div", { className: "dbs_filter_bar" },
						react.createElement("select", {
							className: "dbs_select",
							value: wsFilter,
							onChange: (e) => setWsFilter(e.target.value)
						},
							react.createElement("option", { value: "" }, "全部工作区"),
							workspaces.map((w) => react.createElement("option", { key: w, value: w }, w))
						),
						react.createElement("select", {
							className: "dbs_select",
							value: timeFilter,
							onChange: (e) => setTimeFilter(e.target.value)
						},
							react.createElement("option", { value: "all" }, "全部"),
							react.createElement("option", { value: "today" }, "今天"),
							react.createElement("option", { value: "yesterday" }, "昨天"),
							react.createElement("option", { value: "week" }, "本周"),
							react.createElement("option", { value: "month" }, "本月")
						),
						react.createElement("input", {
							className: "dbs_input",
							placeholder: "搜索会话标题 / ID…",
							value: search,
							onChange: (e) => setSearch(e.target.value)
						})
					),
					react.createElement("div", { className: "dbs_filter_sum" },
						"筛选结果 " + filtered.length + " 个会话 · 输入 " + fmtTokens(filteredSum.uncachedInput + filteredSum.cacheRead + filteredSum.cacheWrite) +
						" · 输出 " + fmtTokens(filteredSum.output) + " · 花费 " + moneyOf(filteredSum.cost) +
						(periodRange !== null ? "　（按「" + (timeFilter === "today" ? "今天" : timeFilter === "yesterday" ? "昨天" : timeFilter === "week" ? "本周" : "本月") + "」统计时段内消耗，非累计总额）" : "")
					),
					filtered.length === 0
						? react.createElement("div", { className: "dbs_muted" }, "没有符合条件的会话")
						: react.createElement("div", { className: "dbs_sessions" },
							filtered.slice(0, 30).map((s) => {
								const entry = entryById.get(s.id);
								const live = entry?.projectionValues?.balanceConsumption;
								// 时间筛选激活: 显示该会话在本时段内的消耗; 否则显示累计(可实时)
								const period = periodRange !== null ? sumPeriod(s.days, periodRange.from, periodRange.to) : null;
								const title = entry?.title ?? s.title ?? "";
								const ws = entry?.cwd ?? s.workspace ?? "";
								const lt = period !== null ? period.tokens : (live?.tokens ?? s.tokens);
								const lc = period !== null ? period.cost : (live?.cost ?? s.cost);
								const dimmed = periodRange !== null && lc <= 0;
								return react.createElement("div", { key: s.id, className: "dbs_sess_row", style: dimmed ? { opacity: 0.45 } : undefined },
									react.createElement("div", { className: "dbs_sess_col" },
										react.createElement("span", { className: "dbs_sess_title", title: title || s.id }, title || shortId(s.id)),
										react.createElement("span", { className: "dbs_sess_ws", title: ws }, ws || "工作区未知")
									),
									react.createElement("span", { className: "dbs_muted" }, fmtDate(entry?.updatedAt ?? s.updated)),
									react.createElement("span", { className: "dbs_value" }, "入 " + fmtTokens((lt.uncachedInput + lt.cacheRead + lt.cacheWrite)) + " · 出 " + fmtTokens(lt.output)),
									react.createElement("span", { className: "dbs_value" }, moneyOf(lc))
								);
							})
						)
				)
			);
		}

		//#region plugin
		const inject = ["slots", "sessions"];

		function apply(ctx) {
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "dsh-balance-stats",
				order: 80,
				label: () => "余额与消耗",
				inject: () => ({ sessionsFeed: ctx.sessions })
			}, BalanceStatsSection));
			// 左侧边栏页脚 KPI 盘头(官方 sidebar.footer.action 插槽, 位于设置行上方)
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "dsh-balance-stats-kpi",
				order: 0
			}, KpiFooter));
		}

		exports.apply = apply;
		exports.inject = inject;
		exports._test = { sumPeriod, dayKeyOfTs };
		return module.exports;
		//#endregion
	}
});
