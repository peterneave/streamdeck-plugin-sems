import streamDeck from "@elgato/streamdeck";

import { SemsSolarOutputAction } from "./actions/sems-solar-output";

// We can enable "trace" logging so that all messages between the Stream Deck, and the plugin are recorded. When storing sensitive information
streamDeck.logger.setLevel("trace");

// Register the SEMS Solar Monitoring action.
streamDeck.actions.registerAction(new SemsSolarOutputAction());

// Finally, connect to the Stream Deck.
streamDeck.connect();
