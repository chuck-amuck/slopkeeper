# Sales and free games

Posts when a game the server wants goes on sale or in a bundle, and when a game is free to keep.

## Sale alerts

Every `SALE_CHECK_HOURS` (default 6), the bot checks Steam prices, and [other stores'](#other-stores) with an IsThereAnyDeal key, for what this server cares about:

- **Played:** games played in voice here in the past 180 days, found by matching the name to a Steam title. Games not on Steam are skipped, and `/game add` with a Steam ID covers a game whose name doesn't match.
- **Wanted:** games someone asked for with `/game want`.
- **Steam wishlists:** games on a linked member's Steam wishlist, if their profile lets the bot see it. A server can turn these off.
- **Library:** games added with a Steam ID.

Prices are checked through the day, so `/sales` and the web UI stay current, but it posts once a day: at 18:00 in the server's time zone by default (`/setup sale-alerts post_hour:`), with everything that's new since the last post, in the announce channel or the channel from `/setup sale-alerts`. That post checks prices again first. If the bot is down at that hour, it posts when it's back that day. A sale that starts and ends between two posts isn't posted, but shows in `/sales` while it's on. Up to 10 games are listed, most wanted first, and the rest are in `/sales`:

> 💸 **3 games on sale**
> **Deep Rock Galactic**: 60% off, $11.99, was $29.99. Lowest price yet. Played 14h · Needs it: @Sam, @Alex
> **Hades**: 50% off, $12.49, was $24.99. Lowest ever $6.24. Wanted by @Jo
> **Portal 2**: $1.99 as a Steam key from Fanatical, 80% under Steam’s $9.99. Lowest ever $0.99. On @Alex’s Steam wishlist

Under the post, **Everything on sale** and **Just mine** show whoever presses them the full list, or only what they want or wishlisted, without posting it for everyone.

A game is posted at 25% off or more by default, then again only if the same sale gets at least 10 points deeper.

### Other stores

With an [IsThereAnyDeal](https://isthereanydeal.com) API key (`ITAD_API_KEY`), the same check also asks IsThereAnyDeal what other official stores charge, such as Humble, Fanatical, Green Man Gaming or GamesPlanet. Only copies that are Steam keys count: GOG, Epic and other launchers' copies, and stores that don't say what they sell, are left out. When a store sells a Steam key for less than Steam does, the post gives that price and store, how far it is under Steam's normal price and, if Steam has a sale too, Steam's price. The store's name links to the deal.

How far under Steam's normal price counts as the discount: the smallest sale worth posting and the 10 points deeper apply to it the same way. A server can leave other stores out (`/setup sale-alerts other_stores:False`). Without a key, only Steam is checked.

With a [gg.deals](https://gg.deals) API key as well (`GGDEALS_API_KEY`), a game that's posted or listed also shows the cheapest key reseller, such as G2A or Kinguin, when it's under every official price: "Key resellers from $7.50 on gg.deals". gg.deals only gives that one price, without saying whether it's a Steam key or an account or which regions it works in, so it never posts a game by itself. Check the offer on gg.deals before buying.

The lowest price ever is the lowest a Steam key has had on Steam or the stores above, from IsThereAnyDeal, in the server's own money. Without a key there's no lowest price. A region IsThereAnyDeal or gg.deals doesn't cover gets Steam's prices only.

Only the people a sale matters to are pinged:

- Whoever wanted it, or has it on their wishlist, until they own it.
- For played and library games, everyone in the group who doesn't have it. A library game that was added by `/game want` only pings the people who wanted it.
- Not anyone who has played it in voice here, as they must have it somehow.
- Not anyone whose Steam library is private, unless they asked for the game, as nobody can tell what they own.

### Bundles

With an IsThereAnyDeal key, the bot also looks through the Humble Bundle, Fanatical and Green Man Gaming bundles running now, once a day at the same hour as sales. The day's new bundles share one post of their own, in the same channel as sales. A bundle is in it once, when it has:

- **A game this server cares about:** one it would post a sale for, as above. The post names the game, the cheapest tier that has it and why, and pings whoever wants it or has it on their Steam wishlist.
- **A game like what you play:** one sharing at least 4 Steam tags with one of the 10 games played most here in the past 180 days, that someone with a linked Steam account doesn't already have. Tags that mean much the same, like Rogue-like, Rogue-lite and Action Roguelike, count once. When most of those 10 games are multiplayer or co-op, the bundle game has to be too. These don't ping anyone.

> 📦 **Resident Evil: Biohazard Unleashed Bundle**
> **Resident Evil 4** in the $18.00 tier: On @Jo’s Steam wishlist
> **Resident Evil 7 Biohazard** in the $10.00 tier: Like Phasmophobia (Horror, Survival Horror, Psychological Horror, First-Person)
> Ends in 5 days
> *Humble Bundle · from $10.00*

DLC and soundtracks are left out, and a bundle with nothing for this server isn't posted, but is looked at again the next day in case someone wants one of its games by then. A post holds up to 10 bundles, as many as fit in Discord's 6,000 characters, and the rest wait for the next day. A server can turn bundles off (`/setup sale-alerts bundles:False`), or keep only the ones with a game it cares about (`bundles_like_we_play:False`).

Games hidden with **Never suggest this** aren't watched for being played or wishlisted, only if someone asked for them. A game nobody needs isn't posted.

The "group" here is the server's members who have linked Steam or marked at least one game as owned. Prices use the server's Steam store region (`/setup steam-region`, default `us`).

| Command | What it does |
| --- | --- |
| `/sales [mine]` | Shows what this server plays or wants that was on sale at the last check, including sales too small to post. A long list has ◀ ▶ buttons to turn the pages. `mine:True` shows only games you want or have on your Steam wishlist. |

The web UI's [Deals](web-ui.md) tab has all of it in one place, as of the bot's last checks.

## Free games

Every 3 hours, the bot checks [GamerPower](https://www.gamerpower.com) for full games that are free to keep on Steam, Epic Games Store or GOG, and posts each new one once. Each post has the store link, what the game normally costs and when the offer ends. DLC, betas and in-game loot are left out.

It's **off by default**. A server admin turns it on with `/setup free-games enabled:True`, optionally with `channel:#free-games` to keep the posts out of the announce channel. Without a channel, they go to the announce channel. When it's first turned on, the bot posts whatever is free at that moment (up to 5), then only new ones.

| Command | What it does |
| --- | --- |
| `/freegames [all]` | Shows what's free to keep right now and passes this server's filters. `all` includes the ones they hide. |

Most giveaways are filler, so a game is only posted if it looks worth having. Each post says why it got through.

| Filter | Default | What it does |
| --- | --- | --- |
| Lowest Steam rating | 70% | Needs this share of positive Steam reviews, from at least 50 reviews. 0 turns it off. |
| Only games like what you play | on | Needs 2 tags in common with the 10 games this server played most in the past 6 months. It's skipped until 3 of those games are on Steam. Tags on nearly everything, like Singleplayer and Indie, don't count. |
| Only multiplayer games | off | Needs a multiplayer or co-op tag. |
| Games not on Steam | hidden | A game with no Steam page can't be rated, so it's hidden unless you show these. |

A game is also hidden if everyone here with a linked Steam account already owns it. Ratings and tags come from [SteamSpy](https://steamspy.com), and tags from Steam's store for games too new for SteamSpy to have any. They're kept for a month, or a day for a game neither had tags for. A hidden game is looked at again at each check, so loosening a filter can still catch it while it's free. If the lookup fails, the game waits for the next check.

The web UI's Settings page lists what's free right now, with the reason each game is posted or hidden.
