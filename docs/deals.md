# Sales and free games

The bot posts when a game the server wants goes on sale or into a bundle, and when a full game is free to keep.

## Sale alerts

Once a day, at 18:00 in the server's time zone unless `/setup sale-alerts post_hour:` says otherwise, the bot posts what went on sale since the last post. If it's down at that hour, it posts when it's back that day:

> 💸 **3 games on sale**
> **Deep Rock Galactic**: 60% off, $11.99, was $29.99. Lowest price yet. Played 14h · Needs it: @Sam, @Alex
> **Hades**: 50% off, $12.49, was $24.99. Lowest ever $6.24. Wanted by @Jo
> **Portal 2**: $1.99 as a Steam key from Fanatical, 80% under Steam’s $9.99. Lowest ever $0.99. On @Alex’s Steam wishlist

**Everything on sale** and **Just mine** under the post show whoever presses them the full list, or only what they want or wishlisted, without posting it again.

It watches four kinds of game:

- **Played:** games played in voice here in the past 180 days that match a Steam title. For a game whose name doesn't match, add it with `/game add` and its Steam ID.
- **Wanted:** games someone asked for with `/game want`.
- **Steam wishlists:** games on a linked member's wishlist, if their profile is public. A server can turn these off.
- **Library:** games added with a Steam ID.

Games hidden with **Never suggest this** are only watched if someone asked for them.

A server that only buys games to play together can post just those: `/setup sale-alerts multiplayer_only:True` keeps games Steam lists as multiplayer, co-op or PvP, and games someone asked for with `/game want`. Bundle posts follow it too. `/sales` and the web UI's Games › Deals still show every sale.

A game is posted at 25% off or more, and again only if the same sale gets at least 10 points deeper. Up to 10 games are listed, most wanted first. The rest, and sales that start and end between two posts, are in `/sales` and the web UI's [Games › Deals](web-ui.md). The hour, the channel, the smallest sale and the rest are set with `/setup sale-alerts` (see [Settings and defaults](server-setup.md#settings-and-defaults)). Prices are in the server's Steam store region, set with `/setup steam-region`.

**Who's pinged:** only the people a sale matters to. That's whoever wanted the game or has it on their wishlist, until they own it. For played and library games, it's also everyone in the group who doesn't own it, except a library game added by `/game want`, which pings only the people who wanted it. The group is the members who linked Steam or marked a game as owned. Nobody who has played it here is pinged, and nobody whose Steam library is private is pinged unless they asked for the game.

| Command | What it does |
| --- | --- |
| `/sales [mine]` | Everything this server plays or wants that was on sale at the last check, including sales too small to post. `mine:True` shows only your wanted and wishlisted games. |

### Other stores

If the host has set an [IsThereAnyDeal](https://isthereanydeal.com) key, the bot also checks official stores like Humble, Fanatical and Green Man Gaming. Only Steam keys count. When a store sells one for less than Steam, the post gives that store's price, how far it is under Steam's, and a link. The lowest price ever also comes from IsThereAnyDeal. A server can leave other stores out with `/setup sale-alerts other_stores:False`.

With a [gg.deals](https://gg.deals) key as well, posts also show the cheapest key reseller, like G2A or Kinguin, when it's under every official price. gg.deals doesn't say whether that's a Steam key or which regions it works in, so a reseller price never posts a game on its own. Check the offer before buying.

### Bundles

With an IsThereAnyDeal key, the bot also checks the Humble Bundle, Fanatical and Green Man Gaming bundles once a day, and gives the day's new ones a post of their own. A bundle is posted once, if it has one of these:

- **A game this server cares about:** one it would post a sale for. The post names the game, the cheapest tier with it, and why, and pings whoever wants it.
- **A game like what you play:** one that shares at least 4 Steam tags with one of the 10 games played most here in the past 180 days, and that someone with a linked Steam account doesn't own. If most of those 10 are multiplayer, the bundle game has to be too. These don't ping anyone.

> 📦 **Resident Evil: Biohazard Unleashed Bundle**
> **Resident Evil 4** in the $18.00 tier: On @Jo’s Steam wishlist
> **Resident Evil 7 Biohazard** in the $10.00 tier: Like Phasmophobia (Horror, Survival Horror, Psychological Horror, First-Person)
> Ends in 5 days
> *Humble Bundle · from $10.00*

DLC and soundtracks are left out. A bundle with nothing for this server is checked again the next day, in case someone wants one of its games by then. `/setup sale-alerts bundles:False` turns bundles off, and `bundles_like_we_play:False` keeps only bundles with a game the server cares about.

## Free games

Every 3 hours, the bot checks [GamerPower](https://www.gamerpower.com) for full games that are free to keep on Steam, Epic or GOG, and posts each new one once, with its link, normal price and end date.

It's **off by default**: turn it on with `/setup free-games enabled:True`, and add `channel:#free-games` to post them somewhere other than the announce channel. When it's first turned on, it posts up to 5 games that are free right then.

Most giveaways are filler, so a game has to pass these filters, and each post says why it got through:

| Filter | Default | What it does |
| --- | --- | --- |
| Lowest Steam rating | 70% | Needs this share of positive Steam reviews, from at least 50 reviews. 0 turns it off. |
| Only games like what you play | on | Needs 2 tags in common with the 10 games played most here in the past 6 months, once at least 3 of those are on Steam. Tags on nearly everything, like Singleplayer and Indie, don't count. |
| Only multiplayer games | off | Needs a multiplayer or co-op tag. |
| Games not on Steam | hidden | They can't be rated, so they're hidden unless you show them. |

A game everyone with a linked Steam account already owns is hidden too. A hidden game is checked again each time while it's free, so loosening a filter can still catch it. The web UI's Settings page lists what's free right now, and why each game is posted or hidden.

| Command | What it does |
| --- | --- |
| `/freegames [all]` | What's free to keep right now and passes this server's filters. `all` includes the hidden ones. |
