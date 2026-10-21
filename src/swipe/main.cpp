#include "swipe.h"

#include <KPluginFactory>

namespace KWin
{

class KWIN_EXPORT SwipeFactory : public PluginFactory
{
    Q_OBJECT
    Q_PLUGIN_METADATA(IID PluginFactory_iid FILE "metadata.json")
    Q_INTERFACES(KWin::PluginFactory)

public:
    explicit SwipeFactory() = default;

    std::unique_ptr<Plugin> create() const override
    {
        return std::make_unique<Swipe>();
    }
};

} // namespace KWin

#include "main.moc"
