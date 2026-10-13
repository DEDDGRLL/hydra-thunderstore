import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Button, Modal } from "@renderer/components";
import { gameDetailsContext } from "@renderer/context";
import type {
  ModGameStatus,
  ModProgressEvent,
  ModSort,
  ThunderstorePackage,
} from "@types";
import "./mods-modal.scss";

const PAGE_SIZE = 20;

export interface ModsModalProps {
  visible: boolean;
  onClose: () => void;
}

type Community = {
  identifier: string;
  name: string;
  packageLoader: string | null;
};

const formatCount = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(1)}k`
      : String(n);

export function ModsModal({ visible, onClose }: Readonly<ModsModalProps>) {
  const { shop, objectId } = useContext(gameDetailsContext);

  const [status, setStatus] = useState<ModGameStatus | null>(null);
  const [tab, setTab] = useState<"browse" | "installed">("browse");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ModSort>("downloads");
  const [page, setPage] = useState(0);
  const [items, setItems] = useState<ThunderstorePackage[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, ModProgressEvent>>(
    {}
  );
  const [communities, setCommunities] = useState<Community[]>([]);
  const [communityFilter, setCommunityFilter] = useState("");

  const refreshStatus = useCallback(async () => {
    if (!objectId) return;
    setStatus(await window.electron.modsGetStatus(shop, objectId));
  }, [shop, objectId]);

  useEffect(() => {
    if (!visible) return;
    refreshStatus().catch((e) => setError(String(e?.message ?? e)));
  }, [visible, refreshStatus]);

  useEffect(() => {
    if (!visible) return;
    return window.electron.onModProgress((event) => {
      setProgress((prev) => ({ ...prev, [event.fullName]: event }));
      if (event.stage === "done" || event.stage === "error") {
        if (event.stage === "error")
          setError(event.message ?? "Install failed");
        refreshStatus();
      }
    });
  }, [visible, refreshStatus]);

  // Community picker data, only needed when auto-detection found nothing.
  useEffect(() => {
    if (!visible || !status || status.community) return;
    window.electron
      .modsListCommunities()
      .then(setCommunities)
      .catch((e) => setError(String(e?.message ?? e)));
  }, [visible, status]);

  // Debounced search.
  useEffect(() => {
    if (!visible || !status?.community || tab !== "browse") return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    const timer = setTimeout(() => {
      window.electron
        .modsSearch(status.community!, {
          query,
          sort,
          page,
          pageSize: PAGE_SIZE,
        })
        .then((result) => {
          if (cancelled) return;
          setItems(result.items);
          setTotal(result.total);
        })
        .catch((e) => !cancelled && setError(String(e?.message ?? e)))
        .finally(() => !cancelled && setLoading(false));
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [visible, status?.community, tab, query, sort, page]);

  const installedMap = useMemo(
    () => new Map((status?.installed ?? []).map((m) => [m.fullName, m])),
    [status]
  );

  const run = async (task: () => Promise<unknown>) => {
    setError(null);
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      refreshStatus();
    }
  };

  const install = (fullName: string) =>
    run(() => window.electron.modsInstall(shop, objectId!, fullName));
  const uninstall = (fullName: string) =>
    run(() => window.electron.modsUninstall(shop, objectId!, fullName, true));
  const toggle = (fullName: string, enabled: boolean) =>
    run(() =>
      window.electron.modsSetEnabled(shop, objectId!, fullName, enabled)
    );

  const pickCommunity = (c: Community) =>
    run(async () => {
      await window.electron.modsSetCommunity(shop, objectId!, c.identifier);
    });

  const renderBody = () => {
    if (!status) return <p className="mods-modal__message">Loading…</p>;

    if (!status.gameDir) {
      return (
        <p className="mods-modal__message">
          Set this game&apos;s executable in Game Options first so Hydra knows
          where to install mods.
        </p>
      );
    }

    if (!status.community) {
      const filtered = communities.filter((c) =>
        c.name.toLowerCase().includes(communityFilter.toLowerCase())
      );
      return (
        <>
          <p className="mods-modal__message">
            Couldn&apos;t match this game to a Thunderstore community
            automatically. Pick one:
          </p>
          <input
            className="mods-modal__input"
            placeholder="Filter games…"
            value={communityFilter}
            onChange={(e) => setCommunityFilter(e.target.value)}
          />
          <div className="mods-modal__list">
            {filtered.slice(0, 100).map((c) => (
              <div key={c.identifier} className="mods-modal__item">
                <div className="mods-modal__info">
                  <h4>{c.name}</h4>
                  <span className="mods-modal__meta">{c.identifier}</span>
                </div>
                <Button theme="outline" onClick={() => pickCommunity(c)}>
                  Use
                </Button>
              </div>
            ))}
          </div>
        </>
      );
    }

    if (!status.loader) {
      return (
        <p className="mods-modal__message">
          This game uses a mod loader that isn&apos;t supported yet (currently
          BepInEx and MelonLoader are).
        </p>
      );
    }

    return (
      <>
        <div className="mods-modal__tabs">
          <Button
            theme={tab === "browse" ? "primary" : "outline"}
            onClick={() => setTab("browse")}
          >
            Browse
          </Button>
          <Button
            theme={tab === "installed" ? "primary" : "outline"}
            onClick={() => setTab("installed")}
          >
            Installed ({status.installed.length})
          </Button>
        </div>

        {tab === "browse" ? renderBrowse() : renderInstalled()}
      </>
    );
  };

  const renderBrowse = () => (
    <>
      <div className="mods-modal__toolbar">
        <input
          className="mods-modal__input"
          placeholder="Search mods…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
        />
        <select
          className="mods-modal__select"
          value={sort}
          onChange={(e) => {
            setSort(e.target.value as ModSort);
            setPage(0);
          }}
        >
          <option value="downloads">Most downloaded</option>
          <option value="rating">Top rated</option>
          <option value="updated">Recently updated</option>
          <option value="name">Name</option>
        </select>
      </div>

      <div className="mods-modal__list">
        {loading && items.length === 0 && (
          <p className="mods-modal__message">
            Loading mods (the first load for a game can take a moment)…
          </p>
        )}
        {!loading && items.length === 0 && (
          <p className="mods-modal__message">No mods found.</p>
        )}
        {items.map((pkg) => {
          const installed = installedMap.get(pkg.fullName);
          const p = progress[pkg.fullName];
          const busy = p && p.stage !== "done" && p.stage !== "error";
          return (
            <div key={pkg.fullName} className="mods-modal__item">
              {pkg.icon && (
                <img
                  className="mods-modal__icon"
                  src={pkg.icon}
                  alt=""
                  loading="lazy"
                />
              )}
              <div className="mods-modal__info">
                <h4>{pkg.name.replace(/_/g, " ")}</h4>
                <div className="mods-modal__meta">
                  by {pkg.owner} · v{pkg.versions[0].version} ·{" "}
                  {formatCount(pkg.downloads)} downloads
                </div>
                <div className="mods-modal__desc">{pkg.description}</div>
              </div>
              <div className="mods-modal__actions">
                {busy ? (
                  <span className="mods-modal__meta">
                    {p.stage} {p.percent}%
                  </span>
                ) : installed ? (
                  <Button
                    theme="outline"
                    onClick={() => uninstall(pkg.fullName)}
                  >
                    Uninstall
                  </Button>
                ) : (
                  <Button onClick={() => install(pkg.fullName)}>Install</Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mods-modal__pager">
        <Button
          theme="outline"
          disabled={page === 0}
          onClick={() => setPage(page - 1)}
        >
          Prev
        </Button>
        <span className="mods-modal__meta">
          Page {page + 1} of {Math.max(1, Math.ceil(total / PAGE_SIZE))} ·{" "}
          {total} mods
        </span>
        <Button
          theme="outline"
          disabled={(page + 1) * PAGE_SIZE >= total}
          onClick={() => setPage(page + 1)}
        >
          Next
        </Button>
      </div>
    </>
  );

  const renderInstalled = () => (
    <div className="mods-modal__list">
      {status!.installed.length === 0 && (
        <p className="mods-modal__message">No mods installed yet.</p>
      )}
      {status!.installed.map((mod) => (
        <div key={mod.fullName} className="mods-modal__item">
          <div className="mods-modal__info">
            <h4>{mod.fullName}</h4>
            <div className="mods-modal__meta">
              v{mod.version}
              {mod.isDependency ? " · dependency" : ""}
              {mod.enabled ? "" : " · disabled"}
            </div>
          </div>
          <div className="mods-modal__actions">
            <Button
              theme="outline"
              onClick={() => toggle(mod.fullName, !mod.enabled)}
            >
              {mod.enabled ? "Disable" : "Enable"}
            </Button>
            <Button theme="danger" onClick={() => uninstall(mod.fullName)}>
              Uninstall
            </Button>
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <Modal
      visible={visible}
      title="Mods"
      description={
        status?.community ? `Thunderstore · ${status.community}` : undefined
      }
      onClose={onClose}
      large
    >
      <div className="mods-modal">
        {renderBody()}
        {error && <div className="mods-modal__error">{error}</div>}
      </div>
    </Modal>
  );
}
