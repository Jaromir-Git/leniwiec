export const stableId = "zaslon-cel-obrony";

const MAX_HP = 7;
const FILTER_NAME = "zaslanianie-proponowany-cel";

const BUILTIN_PROFILES = {
    default: {
        name: "Default",
        values: {
            defenseWeight: 3,
            enemyWeight: 1,
            missingHpWeight: 1,
            passiveWeight: 1,
            threshold: 3,
            badHp: 3
        }
    },
    aggressive: {
        name: "Agresywny",
        values: {
            defenseWeight: 1,
            enemyWeight: 1,
            missingHpWeight: 1,
            passiveWeight: 0,
            threshold: 4,
            badHp: 2
        }
    },
    defensive: {
        name: "Defensywny",
        values: {
            defenseWeight: 5,
            enemyWeight: 2,
            missingHpWeight: 2,
            passiveWeight: 2,
            threshold: 2,
            badHp: 4
        }
    }
};

const FIELDS = [
    ["defenseWeight", "Punkty za wskazany cel obrony", 0, 20],
    ["enemyWeight", "Punkty za każdego atakującego", 0, 20],
    ["missingHpWeight", "Punkty za każdy brakujący poziom HP", 0, 20],
    ["passiveWeight", "Pasywna — punkty za pasywnego członka drużyny", 0, 20],
    ["threshold", "Próg punktów — wynik musi być większy", 0, 100],
    ["badHp", "Zła kondycja — własne HP musi być większe", 0, 6]
];

let cleanup = [];

function ascii(text) {
    return String(text)
        .replace(/ł/g, "l")
        .replace(/Ł/g, "L")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^\x20-\x7E]/g, "")
        .trim();
}

function element(tag, text, parent) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (parent) parent.appendChild(node);
    return node;
}

function copyValues(values) {
    return Object.fromEntries(
        FIELDS.map(([key]) => [
            key,
            key === "passiveWeight" ? values[key] ?? 1 : values[key]
        ])
    );
}

function validValues(values) {
    if (!values || typeof values !== "object") return false;
    const normalized = copyValues(values);

    return FIELDS.every(([key, , min, max]) =>
        Number.isInteger(normalized[key]) &&
        normalized[key] >= min &&
        normalized[key] <= max
    );
}

function createTable(parent, titles) {
    const scroll = element("div", undefined, parent);
    scroll.style.cssText =
        "overflow:auto;max-height:420px;margin-top:12px;";

    const table = element("table", undefined, scroll);
    table.style.cssText =
        "width:100%;border-collapse:collapse;font-size:12px;";

    const header = element(
        "tr", undefined, element("thead", undefined, table)
    );

    for (const title of titles) {
        const th = element("th", title, header);
        th.style.cssText =
            "padding:8px 10px;text-align:left;" +
            "border-bottom:1px solid #777;white-space:nowrap;";
    }

    return element("tbody", undefined, table);
}

function addTableRow(body, values, selected = false) {
    const tr = element("tr", undefined, body);

    if (selected) {
        tr.style.background = "rgba(50,180,100,.18)";
        tr.style.fontWeight = "bold";
    }

    for (const value of values) {
        const td = element("td", value, tr);
        td.style.cssText =
            "padding:8px 10px;border-bottom:1px solid #7775;" +
            "vertical-align:top;";
    }
}

function addEmptyRow(body, message, columns) {
    const tr = element("tr", undefined, body);
    const td = element("td", message, tr);
    td.colSpan = columns;
    td.style.padding = "12px";
}

export async function init(api) {
    let popup;
    let view = null;
    let sending = false;
    let active = true;
    let lastRender = "";
    let coverCooldown = false;
    let markedTargetId = null;
    let filterRegistered = false;
    let actionNotification = null;
    let notificationSignature = "";

    const history = [];
    let historySignature = "";
    let historyEnabledPreviously = false;

    function includePassives() {
        return popup?.getSetting("includePassives", false) === true;
    }

    function historyEnabled() {
        return popup?.getSetting("historyEnabled", false) === true;
    }

    function debugEnabled() {
        return popup?.getSetting("debugEnabled", false) === true;
    }

    function notificationsEnabled() {
        return popup?.getSetting("notificationsEnabled", true) !== false;
    }

    function userProfiles() {
        const stored = popup?.getSetting("weightProfiles", []) ?? [];
        if (!Array.isArray(stored)) return [];

        const ids = new Set();

        return stored.filter((profile) => {
            if (
                !profile ||
                typeof profile.id !== "string" ||
                !profile.id.startsWith("user-") ||
                ids.has(profile.id) ||
                typeof profile.name !== "string" ||
                !profile.name.trim() ||
                !validValues(profile.values)
            ) {
                return false;
            }

            ids.add(profile.id);
            return true;
        }).map((profile) => ({
            id: profile.id,
            name: profile.name.trim(),
            values: copyValues(profile.values),
            builtin: false
        }));
    }

    function profiles() {
        return [
            ...Object.entries(BUILTIN_PROFILES).map(([id, profile]) => ({
                id,
                name: profile.name,
                values: copyValues(profile.values),
                builtin: true
            })),
            ...userProfiles()
        ];
    }

    function currentProfile() {
        const id = popup?.getSetting("activeWeightProfile", "default");
        const available = profiles();
        return available.find((profile) => profile.id === id)
            ?? available[0];
    }

    function config() {
        const profile = currentProfile();
        return {
            ...copyValues(profile.values),
            maxHp: MAX_HP,
            profileId: profile.id,
            profileName: profile.name,
            includePassives: includePassives()
        };
    }

    function activateProfile(id) {
        if (!profiles().some((profile) => profile.id === id)) return;
        popup.setSetting("activeWeightProfile", id);
        lastRender = "";
        render();
    }

    function isFighting(object) {
        return (
            object?.attack_num === true ||
            (typeof object?.attack_num === "number" &&
                object.attack_num > 0)
        );
    }

    function evaluate(macroConfig = {}) {
        const settings = config();
        const objects = api.objects.getObjectsOnLocation();
        const playerId = api.team.getPlayerNum();

        const player = objects.find(
            (object) =>
                object.__category === "player" ||
                (playerId !== undefined && object.num === playerId)
        );

        const allies = objects.filter(
            (object) =>
                object.num === player?.num ||
                object.__category === "player" ||
                object.__category === "team" ||
                object.defense_target === true
        );

        const allyIds = new Set(allies.map((object) => object.num));

        const enemies = objects.filter(
            (object) =>
                !allyIds.has(object.num) &&
                typeof object.attack_num === "number" &&
                allyIds.has(object.attack_num)
        );

        const rows = allies.map((object, index) => {
            const hpValid =
                Number.isFinite(object.hp) &&
                object.hp >= 0 &&
                object.hp <= MAX_HP;

            const attackers = enemies.filter(
                (enemy) => enemy.attack_num === object.num
            );

            const coveredCount = attackers.filter((enemy) =>
                api.combat.isCoveredFor(object.num, enemy.num)
            ).length;

            const defensePoints = object.defense_target
                ? settings.defenseWeight
                : 0;

            const enemyPoints = attackers.length * settings.enemyWeight;
            const hpPoints = hpValid
                ? (MAX_HP - object.hp) * settings.missingHpWeight
                : null;

            return {
                id: object.num,
                name: object.desc || `ob_${object.num}`,
                hp: hpValid ? object.hp : null,
                hpValid,
                index,
                isTeammate: object.__category === "team",
                defenseTarget: object.defense_target === true,
                attackers: attackers.length,
                coveredCount,
                defensePoints,
                enemyPoints,
                hpPoints,
                passivePoints: 0,
                isPassive: false,
                points: hpPoints === null
                    ? null
                    : defensePoints + enemyPoints + hpPoints,
                isSelf: object.num === player?.num,
                status: ""
            };
        });

        const own = rows.find((row) => row.isSelf);

        const passiveMembers = own?.hpValid
            ? rows.filter((row) =>
                !row.isSelf &&
                row.isTeammate &&
                row.hpValid &&
                row.hp > own.hp &&
                row.attackers === 0
            )
            : [];

        for (const row of passiveMembers) {
            row.isPassive = true;
        }

        if (settings.includePassives && own?.hpValid) {
            own.passivePoints =
                passiveMembers.length * settings.passiveWeight;
            own.points += own.passivePoints;
        }

        for (const row of rows) {
            if (row.isSelf) row.status = "Ty";
            else if (!row.hpValid) row.status = "Brak poprawnych danych HP";
            else if (row.hp === 0) row.status = "HP = 0";
            else if (row.attackers === 0) {
                row.status = row.isPassive
                    ? "Pasywny — wyższe HP i brak przeciwników"
                    : "Nikt nie atakuje";
            } else if (row.coveredCount === row.attackers) {
                row.status = "Zasłonięty przed wszystkimi";
            } else if (row.points <= settings.threshold) {
                row.status = "Nie przekracza progu";
            }
        }

        const ranked = rows
            .filter((row) => !row.isSelf && row.status === "")
            .sort(
                (a, b) =>
                    b.points - a.points ||
                    a.hp - b.hp ||
                    b.attackers - a.attackers ||
                    a.index - b.index
            );

        let markerTarget = null;
        let coverTarget = null;
        let coverMessage = coverCooldown
            ? "Zasłona niedostępna — trwa timeout manewru."
            : "Brak celu do zasłony.";

        const best = ranked[0];

        if (best) {
            let reason = "";

            if (!own || !own.hpValid) {
                reason = "Brak poprawnych danych Twojego HP";
            } else if (own.hp <= settings.badHp) {
                reason = "Twoje HP nie przekracza progu złej kondycji";
            } else if (own.attackers >= best.attackers) {
                reason = "Nie masz mniej przeciwników niż cel";
            } else if (own.points >= best.points) {
                reason = "Twoja waga nie jest mniejsza od wagi celu";
            }

            if (reason) {
                best.status = `Najwyższa waga — blokada: ${reason}`;
                coverMessage = `${best.name}: ${reason}.`;
            } else {
                markerTarget = best;

                if (coverCooldown) {
                    best.status = "🛡️ CEL ZASŁONY — trwa timeout";
                    coverMessage =
                        `Cel zasłony: ${best.name}. Oczekiwanie na koniec timeoutu.`;
                } else {
                    coverTarget = best;
                    best.status = "🛡️ WYBRANY DO ZASŁONY";
                    coverMessage = `Zasłoń: ${best.name}.`;
                }
            }

            for (const row of ranked.slice(1)) {
                row.status = "Niższy priorytet";
            }
        }

        const actions = [];
        const leaderId = api.team.getLeaderId();
        const leader = objects.find((object) => object.num === leaderId);
        const currentTarget = objects.find(
            (object) => object.avatar_target === true
        );

        const currentTargetId =
            currentTarget?.num ??
            (
                typeof player?.attack_num === "number" &&
                player.attack_num > 0
                    ? player.attack_num
                    : null
            );

        const playerFighting =
            isFighting(player) || currentTarget !== undefined;

        const teamFighting =
            objects.some(
                (object) =>
                    object.__category === "team" && isFighting(object)
            ) ||
            enemies.some(
                (enemy) =>
                    enemy.attack_num !== player?.num &&
                    objects.some(
                        (object) =>
                            object.__category === "team" &&
                            object.num === enemy.attack_num
                    )
            );

        const markedAttackTarget = objects.find(
            (object) =>
                object.attack_target === true &&
                object.num !== player?.num &&
                object.__category !== "player" &&
                object.__category !== "team" &&
                object.defense_target !== true
        );

        const attackCommand = ascii(
            macroConfig.attackCommand ||
            api.attackController.getAttackCommand()
        );

        const supportCommand = ascii(
            macroConfig.supportCommand ||
            api.attackController.getSupportCommand()
        );

        const coverCommand = ascii(
            macroConfig.coverCommand || "zaslon"
        );

        if (
            player &&
            (teamFighting || playerFighting) &&
            markedAttackTarget &&
            currentTargetId !== markedAttackTarget.num &&
            attackCommand
        ) {
            actions.push({
                type: "attack",
                targetId: markedAttackTarget.num,
                text:
                    `Zaatakuj: ${
                        markedAttackTarget.desc ||
                        `ob_${markedAttackTarget.num}`
                    }`,
                command: `${attackCommand} ob_${markedAttackTarget.num}`
            });
        } else if (
            player &&
            teamFighting &&
            !playerFighting &&
            !markedAttackTarget &&
            supportCommand
        ) {
            const canTargetLeader = leader && leader.num !== player.num;

            actions.push({
                type: "support",
                targetId: canTargetLeader ? leader.num : null,
                text: canTargetLeader
                    ? `Wesprzyj: ${leader.desc || `ob_${leader.num}`}`
                    : "Wesprzyj drużynę",
                command: canTargetLeader
                    ? `${supportCommand} ob_${leader.num}`
                    : supportCommand
            });
        }

        if (!coverCooldown && coverTarget && coverCommand) {
            actions.push({
                type: "cover",
                targetId: coverTarget.id,
                text: `Zasłoń: ${coverTarget.name}`,
                command: `${coverCommand} ob_${coverTarget.id}`
            });
        }

        return {
            rows,
            markerTarget,
            coverTarget,
            coverMessage,
            coverCooldown,
            passiveCount: passiveMembers.length,
            passiveNames: passiveMembers.map((row) => row.name),
            settings,
            actions,
            playerFighting,
            teamFighting,
            currentTargetId,
            markedAttackTargetId: markedAttackTarget?.num ?? null,
            message: actions.length
                ? actions.map((action) => action.text).join(" • ")
                : "Brak proponowanej akcji."
        };
    }

    function conditionFilter(context, result) {
        const target = evaluate().markerTarget;

        if (target && context.object.num === target.id) {
            result.style.prefix = "🛡️ " + (result.style.prefix || "");
        }
    }

    function updateConditionMarker(state) {
        const nextId = state.markerTarget?.id ?? null;
        if (filterRegistered && nextId === markedTargetId) return;

        markedTargetId = nextId;

        if (filterRegistered) {
            api.objectListFilters.unregister(FILTER_NAME);
        }

        api.objectListFilters.register(FILTER_NAME, conditionFilter, 10);
        filterRegistered = true;
    }

    function dismissActionNotification() {
        if (actionNotification) {
            actionNotification.dismiss();
            actionNotification = null;
        }

        notificationSignature = "";
    }

    function updateActionNotification(state) {
        if (!notificationsEnabled() || !state.actions.length) {
            dismissActionNotification();
            return;
        }

        const text = state.actions.map((action) => action.text).join("\n");
        const signature = JSON.stringify(
            state.actions.map(({ type, targetId, text }) => ({
                type, targetId, text
            }))
        );

        if (signature === notificationSignature) return;

        const payload = { text, level: "warning", sticky: true };

        if (actionNotification) {
            actionNotification.update(payload);
        } else {
            actionNotification = api.notifications.show(payload);
        }

        notificationSignature = signature;
    }

    function collectHistory(state) {
        if (!historyEnabled()) {
            historyEnabledPreviously = false;
            historySignature = "";
            return;
        }

        if (!historyEnabledPreviously) {
            historySignature = "";
            historyEnabledPreviously = true;
        }

        const snapshot = {
            message: state.message,
            coverMessage: state.coverMessage,
            coverCooldown: state.coverCooldown,
            targetId: state.markerTarget?.id ?? null,
            passiveCount: state.passiveCount,
            passiveNames: [...state.passiveNames],
            settings: { ...state.settings },
            rows: state.rows.map((row) => ({ ...row })),
            actions: state.actions.map((action) => ({ ...action })),
            playerFighting: state.playerFighting,
            teamFighting: state.teamFighting,
            currentTargetId: state.currentTargetId,
            markedAttackTargetId: state.markedAttackTargetId
        };

        const signature = JSON.stringify(snapshot);
        if (signature === historySignature) return;

        historySignature = signature;
        history.unshift({
            ...snapshot,
            time: new Date().toLocaleTimeString("pl-PL")
        });

        if (history.length > 200) history.length = 200;
    }

    function rowValues(row) {
        return [
            (row.isSelf ? "Ty: " : "") +
            row.name +
            (row.defenseTarget ? " ★" : ""),
            row.id,
            row.hpValid ? `${row.hp}/${MAX_HP}` : "?",
            row.attackers,
            `${row.coveredCount}/${row.attackers}`,
            row.defensePoints,
            row.enemyPoints,
            row.hpPoints ?? "?",
            row.passivePoints,
            row.points ?? "?",
            row.status
        ];
    }

    function renderDebug(state) {
        view.debugSummary.textContent =
            `Profil: ${state.settings.profileName}\n` +
            `${state.message}\n` +
            `Drużyna walczy: ${state.teamFighting ? "tak" : "nie"}. ` +
            `Ty walczysz: ${state.playerFighting ? "tak" : "nie"}.\n` +
            `Twój cel: ${state.currentTargetId ?? "brak"}. ` +
            `Wskazany cel ataku: ${state.markedAttackTargetId ?? "brak"}.\n` +
            `Timeout zasłony: ${state.coverCooldown ? "aktywny" : "brak"}.\n` +
            `Uwzględnij pasywnych: ${
                state.settings.includePassives ? "tak" : "nie"
            }.\n` +
            `Pasywni: ${state.passiveCount}` +
            (
                state.passiveNames.length
                    ? ` — ${state.passiveNames.join(", ")}`
                    : ""
            ) +
            `.\n${state.coverMessage}`;

        view.debugBody.replaceChildren();

        for (const row of state.rows) {
            addTableRow(
                view.debugBody,
                rowValues(row),
                row.id === state.markerTarget?.id
            );
        }

        if (!state.rows.length) {
            addEmptyRow(view.debugBody, "Brak danych drużyny.", 11);
        }
    }

    function renderHistory() {
        view.historyBody.replaceChildren();

        for (const entry of history) {
            const description =
                `[${entry.settings.profileName}] ${entry.message} | ` +
                entry.coverMessage;

            for (const row of entry.rows) {
                addTableRow(
                    view.historyBody,
                    [entry.time, ...rowValues(row), description],
                    row.id === entry.targetId
                );
            }

            if (!entry.rows.length) {
                addEmptyRow(
                    view.historyBody,
                    `${entry.time} — ${description}`,
                    13
                );
            }
        }

        if (!history.length) {
            addEmptyRow(view.historyBody, "Brak zapisanych zmian.", 13);
        }
    }

    function render() {
        if (!active || !popup) return;

        const state = evaluate();
        updateConditionMarker(state);
        updateActionNotification(state);
        collectHistory(state);

        if (!view || !popup.isOpen) return;

        const historyOn = historyEnabled();
        const debugOn = debugEnabled();
        const notificationsOn = notificationsEnabled();
        const passivesOn = includePassives();

        view.historyButton.hidden = !historyOn;
        view.historyToggle.checked = historyOn;
        view.debugButton.hidden = !debugOn;
        view.debugToggle.checked = debugOn;
        view.notificationsToggle.checked = notificationsOn;
        view.passivesToggle.checked = passivesOn;
        view.passiveSliderRow.style.display =
            passivesOn ? "block" : "none";

        if (
            (!historyOn && view.activeTab === "history") ||
            (!debugOn && view.activeTab === "debug")
        ) {
            view.selectTab("action");
        }

        const signature = JSON.stringify({
            state, historyOn, debugOn, notificationsOn, sending, history
        });

        if (signature === lastRender) return;
        lastRender = signature;

        view.profileSummary.textContent =
            `Aktywny profil: ${state.settings.profileName}`;

        view.actionTitle.textContent = state.actions.length
            ? "Proponowane akcje"
            : "Brak proponowanej akcji";

        view.actionTitle.style.color = state.actions.length
            ? "#73d99c"
            : "inherit";

        view.summary.textContent = state.message;
        view.coverSummary.textContent = state.coverMessage;
        view.command.textContent = state.actions.length
            ? state.actions.map((action) => action.command).join("\n")
            : "Alias /leniwiec nie wyśle żadnej komendy.";

        view.executeButton.disabled = !state.actions.length || sending;
        view.executeButton.textContent = sending
            ? "Wykonywanie..."
            : "Wykonaj akcje";

        if (debugOn) renderDebug(state);
        if (historyOn) renderHistory();
    }

    function setCoverCooldown(value) {
        if (!active || coverCooldown === value) return;
        coverCooldown = value;
        lastRender = "";
        render();
    }

    function listen(name, callback) {
        api.events.on(name, callback);
        cleanup.push(() => api.events.off(name, callback));
    }

    listen("cover.start", () => setCoverCooldown(true));
    listen("cover.ready", () => setCoverCooldown(false));

    listen("coverTimer", (value) => {
        if (value === null || value === 0) {
            setCoverCooldown(false);
        } else if (typeof value === "number" && value > 0) {
            setCoverCooldown(true);
        }
    });

    listen("reset", () => setCoverCooldown(false));

    async function execute(macroConfig = {}) {
        if (!active || sending) return;

        const initial = evaluate(macroConfig);

        if (!initial.actions.length) {
            render();
            return;
        }

        sending = true;
        render();

        try {
            const combatAction = initial.actions.find(
                (action) =>
                    action.type === "attack" || action.type === "support"
            );

            if (combatAction && active) {
                await api.command.send(combatAction.command);
            }

            if (!active) return;

            const updated = evaluate(macroConfig);
            const coverAction = updated.actions.find(
                (action) => action.type === "cover"
            );

            if (coverAction && !coverCooldown) {
                await api.command.send(coverAction.command);
            }
        } finally {
            sending = false;
            if (active) render();
        }
    }

    function reportError(error) {
        api.output.print(`[Leniwiec] ${String(error)}`);
    }

    function runActions(macroConfig = {}) {
        void execute(macroConfig).catch(reportError);
    }

    function openPanel() {
        if (!active || !popup) return;

        void popup.open().then(() => {
            if (!active) return;
            lastRender = "";
            render();
        }).catch(reportError);
    }

    function createPanel() {
        const root = element("div");
        root.style.cssText =
            "padding:16px;font:inherit;color:inherit;box-sizing:border-box;";

        const tabs = element("div", undefined, root);
        tabs.style.cssText =
            "display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;";

        const buttons = {};
        const panes = {};

        for (const [name, title] of [
            ["action", "Akcja"],
            ["profiles", "Profile"],
            ["settings", "Ustawienia"],
            ["history", "Historia"],
            ["debug", "Debug"]
        ]) {
            const button = element("button", title, tabs);
            button.type = "button";
            button.style.cssText =
                "padding:8px 16px;cursor:pointer;font:inherit;";
            buttons[name] = button;
            panes[name] = element("div", undefined, root);
        }

        const panelView = {
            activeTab: "action",
            historyButton: buttons.history,
            debugButton: buttons.debug
        };

        function selectTab(tab) {
            if (
                (tab === "history" && !historyEnabled()) ||
                (tab === "debug" && !debugEnabled())
            ) {
                tab = "action";
            }

            panelView.activeTab = tab;

            for (const name of Object.keys(panes)) {
                panes[name].hidden = name !== tab;
                buttons[name].setAttribute("aria-pressed", String(name === tab));
                buttons[name].style.fontWeight =
                    name === tab ? "bold" : "normal";
            }
        }

        panelView.selectTab = selectTab;

        for (const [name, button] of Object.entries(buttons)) {
            button.onclick = () => {
                selectTab(name);
                render();
            };
        }

        // AKCJA
        const profileSummary = element("p", "", panes.action);
        const actionTitle = element("h3", "", panes.action);
        const summary = element("p", "", panes.action);
        const coverSummary = element("p", "", panes.action);
        const command = element("code", "", panes.action);

        command.style.cssText =
            "display:block;padding:16px;margin:14px 0;" +
            "background:rgba(127,127,127,.12);" +
            "border-radius:8px;overflow-wrap:anywhere;white-space:pre-wrap;";

        const executeButton = element(
            "button", "Wykonaj akcje", panes.action
        );
        executeButton.type = "button";
        executeButton.style.cssText = "padding:9px 16px;font:inherit;";
        executeButton.onclick = () => runActions();

        element(
            "p",
            "/leniwiec wykonuje atak lub wsparcie i dostępną zasłonę. " +
            "Podczas timeoutu zasłona jest pomijana, ale tarcza 🛡️ " +
            "przed nazwą celu w Kondycji pozostaje.",
            panes.action
        );

        // PROFILE
        const profilePane = panes.profiles;
        const profileBox = element("div", undefined, profilePane);
        profileBox.style.cssText =
            "padding:16px;border:1px solid #7775;border-radius:8px;" +
            "margin-bottom:16px;";

        const selectLabel = element("label", undefined, profileBox);
        element("span", "Aktywny profil", selectLabel);

        const profileSelect = element("select", undefined, selectLabel);
        profileSelect.style.cssText =
            "display:block;width:100%;padding:8px;margin-top:8px;font:inherit;";

        const profileNote = element("p", "", profileBox);
        element("span", "Nazwa własnego profilu", profileBox);

        const profileName = element("input", undefined, profileBox);
        profileName.type = "text";
        profileName.maxLength = 60;
        profileName.placeholder = "Np. Wyprawa na trolle";
        profileName.style.cssText =
            "display:block;width:100%;box-sizing:border-box;" +
            "padding:8px;margin:8px 0;font:inherit;";

        const profileActions = element("div", undefined, profileBox);
        profileActions.style.cssText =
            "display:flex;gap:8px;flex-wrap:wrap;";

        function actionButton(title) {
            const button = element("button", title, profileActions);
            button.type = "button";
            button.style.cssText = "padding:8px 12px;font:inherit;";
            return button;
        }

        const createButton = actionButton("Utwórz kopię jako nowy profil");
        const saveButton = actionButton("Zapisz zmiany profilu");
        const deleteButton = actionButton("Usuń profil");
        const feedback = element("p", "", profileBox);

        const sliders = {};
        const outputs = {};
        const sliderRows = {};

        for (const [key, title, min, max] of FIELDS) {
            const label = element("label", undefined, profilePane);
            label.style.cssText =
                "display:block;margin:12px 0;padding:14px 18px;" +
                "box-sizing:border-box;border:1px solid #7775;" +
                "border-radius:8px;background:rgba(127,127,127,.06);";

            const caption = element("div", undefined, label);
            caption.style.cssText =
                "display:flex;justify-content:space-between;gap:12px;";

            element("span", title, caption);
            const output = element("output", "", caption);
            output.style.fontWeight = "bold";

            const slider = element("input", undefined, label);
            slider.type = "range";
            slider.min = String(min);
            slider.max = String(max);
            slider.step = "1";
            slider.style.cssText =
                "display:block;width:100%;box-sizing:border-box;" +
                "margin:14px 0 4px;cursor:pointer;";

            slider.oninput = () => {
                output.value = slider.value;
                output.textContent = slider.value;
                feedback.textContent = "Zmiany niezapisane.";
            };

            sliders[key] = slider;
            outputs[key] = output;
            sliderRows[key] = label;
        }

        sliderRows.passiveWeight.style.display =
            includePassives() ? "block" : "none";

        function refreshProfileEditor() {
            const selected = currentProfile();
            profileSelect.replaceChildren();

            for (const profile of profiles()) {
                const option = element(
                    "option",
                    profile.name + (profile.builtin ? " — wbudowany" : ""),
                    profileSelect
                );
                option.value = profile.id;
            }

            profileSelect.value = selected.id;
            profileName.value = selected.builtin ? "" : selected.name;

            for (const [key] of FIELDS) {
                sliders[key].value = String(selected.values[key]);
                sliders[key].disabled = selected.builtin;
                outputs[key].value = String(selected.values[key]);
                outputs[key].textContent = String(selected.values[key]);
            }

            saveButton.disabled = selected.builtin;
            deleteButton.disabled = selected.builtin;

            profileNote.textContent = selected.builtin
                ? "Profil wbudowany jest niezmienny. Nadaj nazwę i utwórz " +
                "kopię, aby edytować własne ustawienia."
                : "Suwaki i nazwa dotyczą tego profilu. Zapisz zmiany, " +
                "aby zastosować je do działania pluginu.";
        }

        function readDraft() {
            const values = Object.fromEntries(
                FIELDS.map(([key]) => [key, Number(sliders[key].value)])
            );

            if (!validValues(values)) {
                throw new Error("Niepoprawne wartości suwaków.");
            }

            return values;
        }

        function readName(excludedId = null) {
            const name = profileName.value.trim();

            if (!name) throw new Error("Podaj nazwę profilu.");
            if (name.length > 60) {
                throw new Error("Nazwa może mieć do 60 znaków.");
            }

            const normalized = name.toLocaleLowerCase("pl-PL");

            if (profiles().some(
                (profile) =>
                    profile.id !== excludedId &&
                    profile.name.toLocaleLowerCase("pl-PL") === normalized
            )) {
                throw new Error("Profil o tej nazwie już istnieje.");
            }

            return name;
        }

        profileSelect.onchange = () => {
            activateProfile(profileSelect.value);
            refreshProfileEditor();
            feedback.textContent = "Profil aktywowany.";
        };

        profileName.oninput = () => {
            feedback.textContent = "Zmiany niezapisane.";
        };

        createButton.onclick = () => {
            try {
                const name = readName();
                const values = readDraft();
                const id =
                    `user-${Date.now().toString(36)}-` +
                    Math.random().toString(36).slice(2, 10);

                popup.setSetting("weightProfiles", [
                    ...userProfiles().map(({ id, name, values }) => ({
                        id, name, values
                    })),
                    { id, name, values }
                ]);

                activateProfile(id);
                refreshProfileEditor();
                feedback.textContent = "Utworzono i aktywowano nowy profil.";
            } catch (error) {
                feedback.textContent = error.message || String(error);
            }
        };

        saveButton.onclick = () => {
            try {
                const selected = currentProfile();
                if (selected.builtin) return;

                const name = readName(selected.id);
                const values = readDraft();

                popup.setSetting(
                    "weightProfiles",
                    userProfiles().map((profile) => ({
                        id: profile.id,
                        name: profile.id === selected.id ? name : profile.name,
                        values: profile.id === selected.id
                            ? values
                            : profile.values
                    }))
                );

                lastRender = "";
                render();
                refreshProfileEditor();
                feedback.textContent = "Zapisano i zastosowano zmiany.";
            } catch (error) {
                feedback.textContent = error.message || String(error);
            }
        };

        deleteButton.onclick = () => {
            const selected = currentProfile();
            if (selected.builtin) return;

            popup.setSetting(
                "weightProfiles",
                userProfiles()
                    .filter((profile) => profile.id !== selected.id)
                    .map(({ id, name, values }) => ({ id, name, values }))
            );

            activateProfile("default");
            refreshProfileEditor();
            feedback.textContent =
                `Usunięto profil „${selected.name}”. Aktywowano Default.`;
        };

        refreshProfileEditor();

        element(
            "p",
            "Profile wbudowane są niezmienne. Aby dostosować wagi, " +
            "utwórz własną kopię. Pasywna: Default 1, Agresywny 0, " +
            "Defensywny 2 punkty za osobę.",
            profilePane
        );

        element(
            "p",
            "Waga każdej postaci = premia celu obrony + punkty za " +
            "przeciwników + punkty za brakujące HP. Jeśli włączono " +
            "pasywnych, do Twojej wagi dochodzi liczba pasywnych " +
            "członków drużyny × waga pasywna.",
            profilePane
        );

        // USTAWIENIA
        const settingsPane = panes.settings;
        element("h3", "Ustawienia ogólne", settingsPane);

        function addToggle(key, title, defaultValue = false) {
            const label = element("label", undefined, settingsPane);
            label.style.cssText =
                "display:flex;align-items:center;gap:10px;" +
                "margin:14px 0;padding:14px 18px;" +
                "border:1px solid #7775;border-radius:8px;cursor:pointer;";

            const input = element("input", undefined, label);
            input.type = "checkbox";
            input.checked =
                (popup?.getSetting(key, defaultValue) ?? defaultValue) === true;

            element("span", title, label);

            input.onchange = () => {
                popup.setSetting(key, input.checked);
                lastRender = "";
                render();
            };

            return input;
        }

        const passivesToggle = addToggle(
            "includePassives",
            "Uwzględnij pasywnych"
        );

        element(
            "p",
            "Pasywny członek drużyny ma więcej HP niż Ty i żadnego " +
            "przeciwnika na sobie. Punkty za każdą taką osobę są " +
            "dodawane wyłącznie do Twojej wagi. Suwak pojawia się " +
            "w zakładce Profile po włączeniu tej opcji.",
            settingsPane
        );

        const notificationsToggle = addToggle(
            "notificationsEnabled",
            "Pokazuj dymki z akcjami",
            true
        );

        const historyToggle = addToggle(
            "historyEnabled",
            "Włącz Historię i zapisywanie zmian"
        );

        const debugToggle = addToggle(
            "debugEnabled",
            "Włącz Debug — tabelę w czasie rzeczywistym"
        );

        element(
            "p",
            "Przełączniki zapisują się od razu. Zasłona wymaga " +
            "zakończonego timeoutu, HP powyżej progu, mniej atakujących " +
            "i mniejszej własnej wagi. Przy równej wadze zasłona " +
            "nie jest proponowana.",
            settingsPane
        );

        const tableTitles = [
            "Postać", "ID", "HP", "Wrogowie", "Zasłony",
            "Cel ★", "Za wrogów", "Za HP", "Za pasywnych",
            "Suma", "Status"
        ];

        element(
            "p",
            "Najnowsze zmiany są na górze. Historia przechowuje do 200 " +
            "zmian i znika po przeładowaniu pluginu. Zielony wiersz " +
            "oznacza proponowany cel, także podczas timeoutu. " +
            "Wpisy pokazują propozycje, nie wykonanie akcji.",
            panes.history
        );

        const clear = element("button", "Wyczyść historię", panes.history);
        clear.type = "button";
        clear.style.cssText = "padding:8px 12px;font:inherit;";
        clear.onclick = () => {
            history.length = 0;
            lastRender = "";
            render();
        };

        const historyBody = createTable(
            panes.history,
            ["Czas", ...tableTitles, "Profil i proponowane akcje"]
        );

        element(
            "p",
            "Dane są sprawdzane co 0,5 sekundy. Zielony wiersz oznacza " +
            "proponowany cel zasłony. Kolumna Za pasywnych pokazuje " +
            "punkty dodane do Twojej postaci.",
            panes.debug
        );

        const debugSummary = element("p", "", panes.debug);
        debugSummary.style.whiteSpace = "pre-wrap";
        const debugBody = createTable(panes.debug, tableTitles);

        Object.assign(panelView, {
            profileSummary,
            actionTitle,
            summary,
            coverSummary,
            command,
            executeButton,
            passivesToggle,
            passiveSliderRow: sliderRows.passiveWeight,
            notificationsToggle,
            historyToggle,
            debugToggle,
            historyBody,
            debugSummary,
            debugBody
        });

        view = panelView;
        buttons.history.hidden = !historyEnabled();
        buttons.debug.hidden = !debugEnabled();
        selectTab("action");
        lastRender = "";

        return root;
    }

    popup = await api.ui.registerPersistentPopup({
        id: "panelZaslaniania",
        title: "Leniwiec",
        initialWidth: 900,
        initialHeight: 560,
        createContent: createPanel
    });

    cleanup.push(() => {
        view = null;
        popup.close();
    });

    cleanup.push(dismissActionNotification);

    cleanup.push(() => {
        api.objectListFilters.unregister(FILTER_NAME);
        filterRegistered = false;
        markedTargetId = null;
    });

    const menu = api.ui.addPopupMenuEntry("Leniwiec — panel", openPanel);
    cleanup.push(() => menu.remove());

    const actionAlias = api.aliases.register(/^\/leniwiec$/, () => {
        runActions();
        return true;
    });
    cleanup.push(() => api.aliases.remove(actionAlias));

    const panelAlias = api.aliases.register(/^\/leniwiecpanel$/, () => {
        openPanel();
        return true;
    });
    cleanup.push(() => api.aliases.remove(panelAlias));

    api.buttonMacros.register({
        id: "zaslonCelObrony",
        label: "Leniwiec — atak, wsparcie i zasłona",

        onClick: (_button, _client, macroConfig) => {
            runActions({
                ...macroConfig,
                coverCommand:
                    macroConfig?.coverCommand ||
                    macroConfig?.command ||
                    "zaslon"
            });
        },

        configFields: [
            {
                name: "attackCommand",
                type: "text",
                label: "Komenda ataku (puste = ustawienia klienta)",
                defaultValue: ""
            },
            {
                name: "supportCommand",
                type: "text",
                label: "Komenda wsparcia (puste = ustawienia klienta)",
                defaultValue: ""
            },
            {
                name: "coverCommand",
                type: "text",
                label: "Komenda zasłony",
                defaultValue: "zaslon"
            }
        ]
    });

    cleanup.push(() =>
        api.buttonMacros.unregister("zaslonCelObrony")
    );

    const timer = setInterval(() => {
        try {
            render();
        } catch (error) {
            console.error("[Leniwiec] Błąd odświeżania:", error);
        }
    }, 500);

    cleanup.push(() => clearInterval(timer));
    cleanup.push(() => {
        active = false;
    });

    if (!popup.isOpen) await popup.open();
    render();

    return {
        name: "Leniwiec",
        version: "5.3.1",
        description:
            "Atak, wsparcie i zasłona pod /leniwiec. " +
            "Domyślny próg punktów: 3. Profile i uwzględnianie pasywnych. " +
            "Panel: /leniwiecpanel."
    };
}

export async function destroy() {
    const disposers = cleanup.reverse();
    cleanup = [];

    for (const dispose of disposers) {
        try {
            dispose();
        } catch (error) {
            console.error("[Leniwiec] Błąd sprzątania:", error);
        }
    }
}