module.exports = {
    branches: ["main"],
    plugins: [
        ["@semantic-release/commit-analyzer", {}],
        ["@semantic-release/release-notes-generator", {}],
        [
            "@semantic-release/npm",
            {
                npmPublish: false,
            },
        ],
        [
            "@semantic-release/git",
            {
                assets: ["package.json"],
                message:
                    "chore: ${nextRelease.version}\n\n${nextRelease.notes}\n\n[skip ci]",
            },
        ],
        ["@semantic-release/github", {}],
        [
            "@codedependant/semantic-release-docker",
            {
                dockerImage: "api",
                dockerProject: "arkcloudstorage",
            },
        ],
    ],
};
