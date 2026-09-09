allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

val newBuildDir: Directory = rootProject.layout.buildDirectory.dir("../../build").get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
subprojects {
    project.evaluationDependsOn(":app")
}

// Patch third-party plugins that target older AGP/Kotlin conventions:
//  - inject a namespace for plugins that only declare the legacy manifest `package`
//    (required by AGP 8+), and
//  - align the Kotlin JVM target with Java (avoids "Inconsistent JVM-target" failures
//    under newer JDKs).
// Done via reflection because AGP/Kotlin Gradle types aren't on the root buildscript classpath.
subprojects {
    val patchPlugin: Project.() -> Unit = {
        extensions.findByName("android")?.let { android ->
            val getNamespace = android.javaClass.getMethod("getNamespace")
            if (getNamespace.invoke(android) == null) {
                android.javaClass.getMethod("setNamespace", String::class.java)
                    .invoke(android, project.group.toString())
            }
            // Java 9+ source needs compileSdk >= 30; we standardize on Java 17 below.
            val currentSdk = android.javaClass.getMethod("getCompileSdk").invoke(android) as Int?
            if (currentSdk == null || currentSdk < 34) {
                android.javaClass.getMethod("setCompileSdk", Int::class.javaPrimitiveType)
                    .invoke(android, 34)
            }
            // Standardize Java source/target on 21 to match the Kotlin JVM target forced
            // below. This keeps both sides aligned (avoids "Inconsistent JVM-target") and is
            // high enough for plugins that use Java 14+ features (e.g. switch expressions).
            val compileOptions = android.javaClass.getMethod("getCompileOptions").invoke(android)
            compileOptions.javaClass.getMethod("setSourceCompatibility", Any::class.java)
                .invoke(compileOptions, JavaVersion.VERSION_21)
            compileOptions.javaClass.getMethod("setTargetCompatibility", Any::class.java)
                .invoke(compileOptions, JavaVersion.VERSION_21)
        }
        tasks.matching { it.javaClass.name.contains("KotlinCompile") }.configureEach {
            val task = this
            // KGP 2.2+ (bundled with AGP 9's built-in Kotlin) removed the legacy
            // `kotlinOptions` accessor in favor of `compilerOptions`. Prefer the modern
            // API and fall back to the legacy one for plugins still on older KGP.
            try {
                val compilerOptions = task.javaClass.getMethod("getCompilerOptions").invoke(task)
                val jvmTargetProp = compilerOptions.javaClass.getMethod("getJvmTarget").invoke(compilerOptions)
                val jvmTargetEnumClass = Class.forName("org.jetbrains.kotlin.gradle.dsl.JvmTarget")
                val jvmTargetEnum = jvmTargetEnumClass
                    .getMethod("fromTarget", String::class.java).invoke(null, "21")
                // Property<T> exposes both set(T) and set(Provider<T>); pick the set(JvmTarget)
                // overload so passing the enum value doesn't hit set(Provider) ("argument type mismatch").
                jvmTargetProp.javaClass.methods.first {
                    it.name == "set" && it.parameterCount == 1 &&
                        it.parameterTypes[0].isAssignableFrom(jvmTargetEnumClass)
                }.invoke(jvmTargetProp, jvmTargetEnum)
            } catch (_: NoSuchMethodException) {
                val kotlinOptions = task.javaClass.getMethod("getKotlinOptions").invoke(task)
                kotlinOptions.javaClass.getMethod("setJvmTarget", String::class.java)
                    .invoke(kotlinOptions, "21")
            }
        }
    }
    // The earlier `evaluationDependsOn(":app")` can evaluate some subprojects before
    // this block runs, which makes afterEvaluate illegal — so apply directly in that case.
    if (state.executed) patchPlugin() else afterEvaluate { patchPlugin() }
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
