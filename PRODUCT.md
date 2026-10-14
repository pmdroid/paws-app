# Paws

## Platform

web

## Stack

The paws.boo landing page is built with Astro. The Paws engine is a local Bun process; the status dashboard is a separate surface built with React, Neobrutalism copy-in components, Tailwind utilities, and shared theme tokens.

## Users

Developers and engineering teams who delegate implementation work from Linear and work in GitHub repositories.

## Product Purpose

Paws takes a delegated Linear issue through coding-agent implementation over ACP, Closeout verification, and a GitHub pull request workflow on the developer's machine.

## Positioning

Paws coordinates the developer's existing coding-agent sessions over ACP rather than replacing their coding tools. Linear holds the work and questions; GitHub holds code and pull requests.

## Operating Context

Developers connect Linear and GitHub, select an implementer, run prerequisite checks, and start Paws locally. The repository README contains the setup commands and links to the operational guides. Developers use the dashboard to monitor work, inspect runs and verification, follow questions back to Linear, configure agent profiles, and manage runners and workspace access.

## Capabilities

The dashboard supports local engine status and explicitly labeled demo data. Navigation, authentication, settings, execution controls, runner management, and workspace administration remain available.

## Brand Commitments

The product is Paws. Its landing-page domain is paws.boo. The landing page includes a GitHub setup action and an on-page workflow explanation. The dashboard uses the Neobrutalism component system from https://www.neobrutalism.dev/docs. Light, dark, and system appearance remain available.

## Evidence on Hand

README.md documents the product workflow and setup. src/web implements the status dashboard.
