class PortfolioAnalyzer {
    constructor() {
        this.initializeElements();
        this.bindEvents();
        this.mockData = this.generateMockData();
    }

    initializeElements() {
        this.uploadArea = document.getElementById('uploadArea');
        this.fileInput = document.getElementById('fileInput');
        this.portfolioUrl = document.getElementById('portfolioUrl');
        this.analyzeBtn = document.getElementById('analyzeBtn');
        this.spinner = document.getElementById('spinner');
        this.btnText = document.querySelector('.btn-text');
        this.resultsSection = document.getElementById('resultsSection');
        this.skillsGrid = document.getElementById('skillsGrid');
        this.rolesList = document.getElementById('rolesList');
        this.skillPopover = document.getElementById('skillPopover');
        this.popoverClose = document.getElementById('popoverClose');
    }

    bindEvents() {
        // Tab switching
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => this.switchTab(e.target.dataset.tab));
        });

        // File upload events
        this.uploadArea.addEventListener('click', () => this.fileInput.click());
        this.uploadArea.addEventListener('dragover', (e) => this.handleDragOver(e));
        this.uploadArea.addEventListener('dragleave', (e) => this.handleDragLeave(e));
        this.uploadArea.addEventListener('drop', (e) => this.handleFileDrop(e));
        this.fileInput.addEventListener('change', (e) => this.handleFileSelect(e));

        // Analyze button
        this.analyzeBtn.addEventListener('click', () => this.analyzeProfile());

        // Popover close
        this.popoverClose.addEventListener('click', () => this.closePopover());
        this.skillPopover.addEventListener('click', (e) => {
            if (e.target === this.skillPopover) this.closePopover();
        });
    }

    switchTab(tabName) {
        // Update tab buttons
        document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
        document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');

        // Update tab content
        document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
        document.getElementById(`${tabName}-tab`).classList.add('active');
    }

    handleDragOver(e) {
        e.preventDefault();
        this.uploadArea.classList.add('dragover');
    }

    handleDragLeave(e) {
        e.preventDefault();
        this.uploadArea.classList.remove('dragover');
    }

    handleFileDrop(e) {
        e.preventDefault();
        this.uploadArea.classList.remove('dragover');
        const files = e.dataTransfer.files;
        if (files.length > 0 && files[0].type === 'application/pdf') {
            this.fileInput.files = files;
            this.updateUploadArea(files[0].name);
        }
    }

    handleFileSelect(e) {
        const file = e.target.files[0];
        if (file) {
            this.updateUploadArea(file.name);
        }
    }

    updateUploadArea(fileName) {
        this.uploadArea.innerHTML = `
            <svg class="upload-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14,2 14,8 20,8"/>
                <line x1="16" y1="13" x2="8" y2="13"/>
                <line x1="16" y1="17" x2="8" y2="17"/>
                <polyline points="10,9 9,9 8,9"/>
            </svg>
            <p>✅ ${fileName} selected</p>
        `;
    }

    async analyzeProfile() {
        const activeTab = document.querySelector('.tab-content.active').id;
        let hasInput = false;

        if (activeTab === 'pdf-tab') {
            hasInput = this.fileInput.files.length > 0;
        } else {
            hasInput = this.portfolioUrl.value.trim() !== '';
        }

        if (!hasInput) {
            alert('Please upload a PDF or enter a portfolio URL');
            return;
        }

        // Show loading state
        this.analyzeBtn.disabled = true;
        this.spinner.style.display = 'block';
        this.btnText.textContent = 'Analyzing...';

        // Simulate API call
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Hide loading state
        this.spinner.style.display = 'none';
        this.btnText.textContent = 'Analysis Complete!';

        // Show results
        setTimeout(() => {
            this.showResults();
        }, 500);
    }

    showResults() {
        this.resultsSection.style.display = 'block';
        this.renderSkills();
        this.renderRoles();
        
        // Scroll to results
        this.resultsSection.scrollIntoView({ behavior: 'smooth' });
    }

    renderSkills() {
        const skillsHTML = this.mockData.skills.map(skill => `
            <div class="skill-tile">
                <div class="skill-header">
                    <div class="skill-name">${skill.name}</div>
                </div>
                <div class="skill-level">
                    <div class="level-bar">
                        <div class="level-fill ${skill.level}"></div>
                    </div>
                    <span class="level-text">${skill.level}</span>
                </div>
                <button class="view-proof-btn" onclick="portfolioApp.showProof('${skill.name}', '${skill.proof}')">
                    View Proof
                </button>
            </div>
        `).join('');
        
        this.skillsGrid.innerHTML = skillsHTML;
    }

    renderRoles() {
        const rolesHTML = this.mockData.roles.map(role => `
            <div class="role-card">
                <div class="role-header">
                    <div>
                        <h3 class="role-title">${role.title}</h3>
                    </div>
                    <div class="role-score">
                        <div class="score-bar">
                            <div class="score-fill" style="width: ${role.score}%"></div>
                        </div>
                        <div class="score-text">${role.score}% match</div>
                    </div>
                </div>
                <div class="role-details">
                    <div class="detail-section why-section">
                        <h4>Why You're a Great Fit</h4>
                        <p>${role.why}</p>
                    </div>
                    <div class="detail-section gaps-section">
                        <h4>Skills to Develop</h4>
                        <p>${role.gaps}</p>
                    </div>
                </div>
                <button class="apply-btn" onclick="portfolioApp.applyForRole('${role.title}')">
                    Apply Now
                </button>
            </div>
        `).join('');
        
        this.rolesList.innerHTML = rolesHTML;
    }

    showProof(skillName, proof) {
        document.getElementById('popoverTitle').textContent = skillName;
        document.getElementById('popoverText').textContent = proof;
        this.skillPopover.style.display = 'flex';
    }

    closePopover() {
        this.skillPopover.style.display = 'none';
    }

    applyForRole(roleTitle) {
        // Simulate opening job application
        alert(`Opening application for ${roleTitle}...`);
        // In a real app, this would redirect to job application page
        console.log(`Applying for role: ${roleTitle}`);
    }

    generateMockData() {
        return {
            skills: [
                {
                    name: "JavaScript",
                    level: "advanced",
                    proof: "Built multiple React applications including an e-commerce platform with complex state management, API integrations, and real-time features using WebSocket connections."
                },
                {
                    name: "Python",
                    level: "intermediate",
                    proof: "Developed data analysis scripts using pandas and NumPy, created REST APIs with Flask, and automated testing workflows for web applications."
                },
                {
                    name: "React",
                    level: "advanced",
                    proof: "Led development of component library used across 5 projects, implemented advanced patterns like render props and hooks, optimized performance for large datasets."
                },
                {
                    name: "Node.js",
                    level: "intermediate",
                    proof: "Built RESTful APIs serving 10k+ requests daily, implemented authentication systems, integrated with MongoDB and PostgreSQL databases for various projects."
                },
                {
                    name: "Machine Learning",
                    level: "beginner",
                    proof: "Completed online courses in ML fundamentals, implemented basic classification models using scikit-learn, currently working on personal project predicting stock trends."
                },
                {
                    name: "UI/UX Design",
                    level: "intermediate",
                    proof: "Designed user interfaces for 3 mobile apps, conducted user research and usability testing, proficient in Figma and Adobe XD for prototyping."
                }
            ],
            roles: [
                {
                    title: "Full Stack Developer",
                    score: 92,
                    why: "Your strong JavaScript and React skills, combined with Node.js backend experience, make you an ideal candidate. Your portfolio demonstrates end-to-end development capabilities.",
                    gaps: "Consider strengthening database design skills and learning Docker for containerization. Cloud deployment experience would be valuable."
                },
                {
                    title: "Frontend Developer",
                    score: 95,
                    why: "Exceptional React and JavaScript expertise with UI/UX design background. Your component library experience shows senior-level thinking about reusable code.",
                    gaps: "Advanced CSS animations and WebGL knowledge could set you apart. Consider learning TypeScript for larger applications."
                },
                {
                    title: "Product Manager",
                    score: 68,
                    why: "Your technical background provides excellent foundation for communicating with development teams. UI/UX experience shows user-focused thinking.",
                    gaps: "Need to develop skills in market analysis, product strategy, and stakeholder management. Consider getting certified in Agile methodologies."
                },
                {
                    title: "Data Scientist",
                    score: 45,
                    why: "Python experience and beginner ML knowledge provide a starting foundation. Programming background will help with implementation.",
                    gaps: "Significant skill development needed in statistics, advanced ML algorithms, and data visualization tools like Tableau or D3.js."
                }
            ]
        };
    }
}

// Initialize the application
const portfolioApp = new PortfolioAnalyzer();