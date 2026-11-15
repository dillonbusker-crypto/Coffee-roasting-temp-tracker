# Roast Tracker

A phone web app that reads a ThermoPro TP17's display through the camera during a roast on a Sweet Maria's Popper. It plots temperature and rate of rise live and gives spoken cues when the roast drifts off target.

- **Spec:** [docs/SPEC.md](docs/SPEC.md)
- **Design and module contracts:** [docs/DESIGN.md](docs/DESIGN.md)
- **Build status and what is pending:** [docs/STATUS.md](docs/STATUS.md)

The app is static files with no build step. GitHub Pages serves the root of `main`.

## Run locally

```
npm run serve     # http://localhost:8080
npm test          # unit tests for the maths, session and cues
```

Camera access needs HTTPS or `localhost`.
