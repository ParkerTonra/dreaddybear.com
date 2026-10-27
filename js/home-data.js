// Landing page content. Edit this file to change what the home page shows; js/home.js draws it.
//
// featured: the hero. Put your games here; with more than one entry the hero gets a switcher.
//   media.type is one of:
//     "ants"  - the animated ant canvas (no image needed)
//     "image" - { type: "image", src: "/assets/pictures/x.png", alt: "..." }
//     "video" - { type: "video", src: "/assets/video/x.mp4" } (muted, looping)
//     "embed" - { type: "embed", src: "https://..." } (an iframe, e.g. an itch.io widget)
//
// music: the second section (latest mix player + where to listen).
// cards: the grid under it. icon is a Font Awesome 4.7 name without "fa-".

window.SITE = {
    featured: [
        {
            eyebrow: "Play now",
            title: "Ant Arena",
            blurb: "Battle your friends in this tactical RTS inspired arcade game!",
            media: { type: "ants" },
            actions: [
                { label: "Play Ant Arena", href: "/ants/play/" }
            ]
        }
    ],

    music: {
        eyebrow: "Music",
        title: "Latest mix",
        player: "https://w.soundcloud.com/player/?url=https%3A//soundcloud.com/dreaddybear/444-twenty&color=%234f46e5&auto_play=false&hide_related=true&show_comments=false&show_user=true&show_reposts=false&visual=true",
        links: [
            { label: "Bandcamp", icon: "bandcamp", href: "https://dreaddybear.bandcamp.com/" },
            { label: "Spotify", icon: "spotify", href: "https://open.spotify.com/artist/2Y5cVABDv3tlprqWSHx2Op" },
            { label: "SoundCloud", icon: "soundcloud", href: "https://soundcloud.com/dreaddybear" },
            { label: "Apple Music", icon: "apple", href: "https://music.apple.com/us/artist/dreaddy-bear/1384832055" }
        ]
    },

    cards: [
        {
            icon: "spotify",
            title: "Dreaddy Spaghetti",
            text: "The playlist. Long, saucy, no skips.",
            href: "/pages/playlist.html"
        },
        {
            icon: "circle-o-notch",
            title: "Fate Decider",
            text: "Can't decide? Spin the wheel and let it ruin your night.",
            href: "/pages/wheel.html"
        },
        {
            icon: "github",
            title: "GitHub",
            text: "Code, experiments and half-finished ideas.",
            href: "https://github.com/ParkerTonra"
        },
        {
            icon: "gift",
            title: "Free stuff",
            text: "Totally legit. Click it.",
            href: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        }
    ]
};
