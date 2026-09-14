# Firebase's ComponentDiscovery instantiates these registrars via reflection
# (Class.newInstance() on a no-arg constructor). R8 doesn't see that reflective
# call and strips the constructors in release builds, which breaks
# FirebaseAppCheck.activate() (works in debug because nothing is shrunk there).
-keep public class * extends com.google.firebase.components.ComponentRegistrar
-keepclassmembers public class * extends com.google.firebase.components.ComponentRegistrar {
    public <init>();
}
