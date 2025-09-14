# HackMIT 2025!

## Table of Contents

- [About](#about)  
- [Features](#features)  
- [Tech Stack](#tech-stack)  
- [Setup & Installation](#setup--installation)  
- [Usage](#usage)  
- [License](#license)  

---


## About

**HackMIT 2025** is a project by the *GapLess* team aiming to create a living, verifiable skills profile that turns your real work (docs, links, repos) into a structured, evidence-backed portfolio, maps you to non-obvious roles, and generates tailored “apply” packets in one click.

We built both a **frontend** and **backend** to make this possible:  
- **Frontend:** A clean, interactive web interface where users can upload artifacts, view Skill Tiles, explore role matches, and generate application packets.  
- **Backend:** A robust service layer that ingests documents, processes them through Claude for skill extraction, links skills to proof snippets, matches users against a role library, and assembles dynamic recruiter packets.  

---

## Features
- **Ingest real work**  
  Upload resumes, LinkedIn PDFs, GitHub repos, writing samples, lab reports, or awards.
- **Evidence-backed skill extraction**  
  Uses Claude to convert artifacts into *Skill Tiles* with name, level, last-seen date, and proof snippets tied directly to the source.
- **Role matching & discovery**  
  Maps skills to a curated library of 30–50 roles, returning top matches with “why” explanations and gap analysis — including *non-obvious roles* through adjacent skill discovery.
- **Instant role-specific applications**  
  Links to the job application page.

---

## Tech Stack

| Component    | Technology |
|--------------|------------|
| Frontend     | HTML/JS/CSS |
| Backend      | Python Jupyter |
| Additional   | Claude API |

---

## Setup & Installation

1. **Clone the repo**  
   ```bash
   git clone https://github.com/pr4-kp/hackmit2025.git
   cd hackmit2025
2. **Backend setup**
    - Navigate to backend/
    - Install dependencies:
    ```bash
    # Example
    npm install
    # or
    pip install -r requirements.txt

    - Configure environment variables (e.g. DB connection strings, API keys)
    - Run migrations (if needed)
    - Start backend server
3. **Frontend setup**
    - Navigate to frontend/
    - Install dependencies
    - Start frontend server/dev build
4. **Environment**
    - Any environment variables or config files needed
    - Ports / URLs used
    - How to run in development vs production
## Usage

Click on the url to access the website
Upload your resume/paper or any other things that says about you
Get your customized job recommendation

## License

[Specify license here, e.g. MIT License]