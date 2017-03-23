import * as express from "express";

const router = express.Router();

const defaultPartials = {
    layout: "layout",
};

/**
 * Route to retrieve the home page for the app
 */
router.get("/", (request, response, next) => {
    response.render(
        "home",
        {
            partials: defaultPartials,
            title: "Edera",
        });
});

export default router;
